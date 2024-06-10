import { assert } from './utils.js';
// import { NODE_SCHEMA } from './model.js';
import * as synth from './synth.js';

/**
MIDI clock pulses per quarter note
*/
export const CLOCK_PPQ = 24;

/**
MIDI clock pulses per 16th note
*/
export const CLOCK_PPS = CLOCK_PPQ / 4;

/**
 * Stateful graph that generates audio samples
 */
export class AudioGraph
{
    constructor(sampleRate, send)
    {
        assert (sampleRate == 44100);
        this.sampleRate = sampleRate;

        // Current playback position in seconds
        this.playPos = 0;

        // Compiled code to generate audio samples
        this._genSample = null;

        // Method to send messages to the main thread
        this.send = send;

        // Stateful audio processing nodes, indexed by nodeId
        this.nodes = [];
    }

    /**
     * Update the audio graph given a new compiled unit
     */
    newUnit(unit)
    {
        // Note that we don't delete any nodes, even if existing nodes are
        // currently not listed in the compiled unit, because currently
        // disconnected nodes may get reconnected, and deleting things like
        // delay lines would lose their current state.
        // All nodes get garbage collected when the playback is stopped.

        // For each audio node
        for (let nodeId in unit.nodes)
        {
            let nodeState = unit.nodes[nodeId];

            let nodeClass = (
                nodeState.type in NODE_CLASSES?
                NODE_CLASSES[nodeState.type]:
                AudioNode
            );

            // If a node with this nodeId is already mapped
            if (this.nodes[nodeId])
            {
                let node = this.nodes[nodeId];

                // The existing node must have the same type
                assert (node instanceof nodeClass);

                // Update the node's state
                node.setState(nodeState);
            }
            else
            {
                // Create a new audio node
                this.nodes[nodeId] = new nodeClass(
                    nodeId,
                    nodeState,
                    this.sampleRate,
                    this.send
                );
            }
        }

        // Create the sample generation function
        this._genSample = new Function(
            'time',
            'nodes',
            unit.src
        );
    }

    /**
     * Parse a message from the main thread
     */
    parseMsg(msg)
    {
        let node = ('nodeId' in msg)? this.nodes[msg.nodeId]:null;

        switch (msg.type)
        {
            case 'NEW_UNIT':
            this.newUnit(msg.unit);
            break;

            case 'SET_PARAM':
            node.setParam(msg.paramName, msg.value);
            break;

            case 'SET_STATE':
            node.setState(msg.state);
            break;

            case 'SET_CELL':
            node.setCell(msg.patIdx, msg.stepIdx, msg.rowIdx, msg.value);
            break;

            case 'QUEUE_PATTERN':
            node.queuePattern(msg.patIdx, msg.patData);
            break;

            case 'NOTE_ON':
            node.noteOn(msg.noteNo, msg.velocity);
            break;

            default:
            throw new TypeError('unknown message type');
        }
    }

    /**
     * Generate one [left, right] pair of audio samples
     */
    genSample()
    {
        if (!this._genSample)
            return [0, 0];

        this.playPos += 1 / 44100;
        return this._genSample(this.playPos, this.nodes);
    }
}

/**
 * Base class for stateful audio processing nodes
 */
class AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        this.nodeId = id;
        this.state = state;
        this.params = state.params;
        this.sampleRate = sampleRate;
        this.sampleTime = 1 / sampleRate;
        this.send = send;
    }

    /**
     * Set a parameter value on a given node
     */
    setParam(paramName, value)
    {
        assert (paramName in this.params);
        this.params[paramName] = value;
    }

    /**
     * Set/update the entire state for this node
     */
    setState(state)
    {
        this.state = state;
        this.params = state.params;
    }
}

/**
 * ADSR envelope
 */
class ADSRNode extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);
        this.env = new synth.ADSREnv();
    }

    update(time, gate, attack, decay, susVal, release)
    {
        return this.env.eval(time, gate, attack, decay, susVal, release)
    }
}

/**
 * Clock source, with tempo in BPM
 */
class Clock extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);
        this.phase = 0;
    }

    update(bpm)
    {
        // let freq = music.CLOCK_PPQ * this.params.value / 60; // <-- og
        let freq = CLOCK_PPQ * bpm / 60; 
        let duty = 0.5;
        this.phase += this.sampleTime * freq;
        let cyclePos = this.phase % 1;

        // Note that the clock starts high so that it will
        // trigger immediately upon starting
        return (cyclePos < duty)? 1:-1;
    }
}

/**
 * Clock signal divider
 */
class ClockDiv extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        // Last clock sign at the input (positive/negative)
        this.inSgn = true;

        // Current clock sign at the output (positive/negative)
        // We start high to trigger immediately upon starting,
        // just like the Clock node
        this.outSgn = true;

        // Number of input ticks since the last output tick
        this.clockCnt = 0;
    }

    // update(clock) // <- og
    update(clock, factor = this.params.factor)
    {
        // Current clock sign at the input
        let curSgn = (clock > 0);

        // If the input clock sign just flipped
        if (this.inSgn != curSgn)
        {
            // Count all edges, both rising and falling
            this.clockCnt++;

            // If we've reached the division factor
            // if (this.clockCnt >= factor) // <- og
            if (this.clockCnt >= factor)
            {
                // Reset the clock count
                this.clockCnt = 0;

                // Flip the output clock sign
                this.outSgn = !this.outSgn;
            }
        }

        this.inSgn = curSgn;

        return this.outSgn? 1:-1;
    }
}

/**
 * Clock output node
 */
class ClockOut extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        // Last clock sign at the input (positive/negative)
        this.inSgn = false;
    }

    update(time, clock)
    {
        // Current clock sign at the input
        let curSgn = (clock > 0);

        // If the input clock sign just went positive (rising edge)
        if (curSgn && this.inSgn != curSgn)
        {
            // Send a clock pulse back to the main thread
            this.send({
                type: 'CLOCK_PULSE',
                nodeId: this.nodeId,
                time: time
            });
        }

        this.inSgn = curSgn;
        return 0; // <-- added this
    }
}

/**
 * Delay line node
 */
class Delay extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        // Stateful delay line object
        this.delay = new synth.Delay(sampleRate);
    }
    // og noisecraft splits nodes here, but it seems to work..
    update(input, time) {
      this.delay.write(input, time);
      return this.delay.read()
    }
}

/**
 * Overdrive-style distortion
 */
class Distort extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);
    }

    update(input, amount)
    {
        return synth.distort(input, amount);
    }
}

/**
 * Sample and hold
 */
class Hold extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        // Value currently being held
        this.value = 0;

        // Current trig input sign (positive/negative)
        this.trigSgn = false;
    }

    write(value, trig)
    {
        if (!this.trigSgn && trig > 0)
            this.value = value;

        this.trigSgn = (trig > 0);
    }

    read()
    {
        return this.value;
    }

    update(input, trig)
    { // in the oh noisecraft, hold is split into 2 intermediate nodes, not sure why.. (same as delay)
        this.write(input, trig);
        return this.read()
    }
}

/**
 * White noise source
 */
class NoiseOsc extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);
    }

    update()
    {
        let minVal = this.params.minVal;
        let maxVal = this.params.maxVal;
        let range = maxVal - minVal;
        return minVal + range * Math.random();
    }
}

/**
 * Pulse wave oscillator
 */
class PulseOsc extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        this.phase = 0;
    }

    update(freq, duty)
    {
        let minVal = this.params.minVal;
        let maxVal = this.params.maxVal;

        this.phase += this.sampleTime * freq;
        let cyclePos = this.phase % 1;
        return (cyclePos < duty)? minVal:maxVal;
    }
}

/**
 * Sawtooth wave oscillator
 */
class SawOsc extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        // Current time position
        this.phase = 0;
    }

    update(freq)
    {
        let minVal = this.params.minVal;
        let maxVal = this.params.maxVal;

        this.phase += this.sampleTime * freq;
        let cyclePos = this.phase % 1;
        return minVal + cyclePos * (maxVal - minVal);
    }
}

/**
 * Sine wave oscillator
 */
class SineOsc extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        // Current time position
        this.phase = 0;

        // Current sync input sign (positive/negative)
        this.syncSgn = false;
    }

    update(freq, sync)
    {
        let minVal = this.params.minVal;
        let maxVal = this.params.maxVal;

        if (!this.syncSgn && sync > 0)
            this.phase = 0;

        this.syncSgn = (sync > 0);

        let cyclePos = this.phase % 1;
        this.phase += this.sampleTime * freq;

        let v = Math.sin(cyclePos * 2 * Math.PI);
        let normVal = (v + 1) / 2;

        return minVal + normVal * (maxVal - minVal);
    }
}

/**
 * Triangle wave oscillator
 */
class TriOsc extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        // Current time position
        this.phase = 0;
    }

    update(freq)
    {
        let minVal = this.params.minVal;
        let maxVal = this.params.maxVal;

        this.phase += this.sampleTime * freq;
        let cyclePos = this.phase % 1;

        // Compute a value between 0 and 1
        let normVal = (cyclePos < 0.5)? (2 * cyclePos):(1 - 2 * (cyclePos - 0.5));

        return minVal + normVal * (maxVal - minVal);
    }
}

/**
 * Scope to plot incoming signals
 */
/* class Scope extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        const SEND_SIZE = NODE_SCHEMA.Scope.sendSize;
        const SEND_RATE = NODE_SCHEMA.Scope.sendRate;

        // How often to gather samples
        this.sampleInterv = sampleRate / (SEND_SIZE * SEND_RATE);
        assert (isPosInt(this.sampleInterv));

        // Buffer of samples to be send
        this.buffer = new Array(SEND_SIZE);

        // How many samples we've seen in total
        this.numSamples = 0;

        // How many samples we have ready to send
        this.numReady = 0;
    }

    update(inVal)
    {
        if (this.numSamples % this.sampleInterv == 0)
        {
            this.buffer[this.numReady] = inVal;
            this.numReady++;

            if (this.numReady == this.buffer.length)
            {
                // Send the current step back to the main thread
                this.send({
                    type: 'SEND_SAMPLES',
                    nodeId: this.nodeId,
                    samples: this.buffer
                });

                this.numReady = 0;
            }
        }

        this.numSamples++;
    }
} */

/**
 * Slide/portamento node
 */
class Slide extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        // Current state
        this.s = 0;
    }

    update(input, rate)
    {
        // Remap so the useful range is around [0, 1]
        rate = rate * 1000;

        if (rate < 1)
            rate = 1;

        this.s += (1 / rate) * (input - this.s);

        return this.s;
    }
}

/**
 * Two-pole low-pass filter
 */
class Filter extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        this.filter = new synth.TwoPoleFilter();
    }

    update(input, cutoff, reso)
    {
        return this.filter.apply(input, cutoff, reso);
    }
}

/**
 * Wavefolder
 */
class Fold extends AudioNode
{
    /**
     * I create a new Wavefold node.
     *
     * @param  {Number}  id - id of this node
     * @param  {Object}  state - initial state
     * @param  {Number}  sampleRate - audio sample rate
     * @param  {Function}  send - event handler
     */
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);
        // redundant ctor
    }

    /**
     * Distort incoming audio signal by "folding".
     *
     * <blockquote style="background-color:whitesmoke">
     *  assume x is <em>[input]</em> and amp is <em>[rate]</em>
     *  <pre>
     *    f(x) = x * amp
     *    g(x) = 4(abs(0.25x+0.25-round(0.25x+0.25))-0.25)
     *    g(f(x)) => out
     *  </pre>
     * </blockquote>
     * See {@link  https://www.keithmcmillen.com/blog/simple-synthesis-part-8-wavefolding/}
     * and {@link https://jatinchowdhury18.medium.com/complex-nonlinearities-episode-6-wavefolding-9529b5fe4102}
     *
     * @param  {Sample}  input - signal
     * @param  {PositiveReal}  rate - amplitude of fold
     * @returns  {Sample}
     */
    update(input, rate)
    {
        // Make it so rate 0 means input unaltered because
        // NoiseCraft knobs default to the [0, 1] range
        if (rate < 0) rate = 0;
        rate = rate + 1;

        input = input * rate;
        return 4 * (Math.abs(0.25 * input + 0.25 - Math.round(0.25 * input + 0.25)) - 0.25);
    }
}

/**
 * Midi input node with freq and gate outputs
 */
/* class MidiIn extends AudioNode
{
    constructor(id, state, sampleRate, send)
    {
        super(id, state, sampleRate, send);

        // Current note being held
        this.noteNo = 0;

        // Frequency of the note being held
        this.freq = 0;

        // Current gate state
        this.gateState = 'off';
    }

    noteOn(noteNo, velocity)
    {
        if (velocity > 0)
        {
            this.noteNo = noteNo;
            // this.freq = music.Note(noteNo).getFreq(); // <- og
            this.freq = midi2freq(noteNo);
            this.gateState = 'pretrig';
        }
        else
        {
            if (noteNo == this.noteNo)
            {
                this.noteNo = 0;
                this.gateState = 'off';
            }
        }
    }

    update()
    {
        // The pretrig state serves to force the gate to go to
        // zero for at least one cycle so that ADSR envelopes
        // can be retriggered if already active.
        switch (this.gateState)
        {
            case 'pretrig':
            this.gateState = 'on';
            return [0, 0];

            case 'on':
            return [this.freq, 1];

            case 'off':
            return [this.freq, 0];

            default:
            assert (false);
        }
    }
} */

// removed: Sequencer, MonoSeq, GateSeq

/**
 * Sequence of Signals (new)
 */
export class Sequence extends AudioNode {
  constructor(id, state, sampleRate, send) {
    super(id, state, sampleRate, send);
    this.clockSgn = true;
    this.step = 0;
    this.first= true
  }
  // TODO: use CLOCK_PPS to get correct tempo...
  update(clock, ...ins) {
    if (!this.clockSgn && clock > 0) {
      this.step = (this.step + 1) % ins.length;
      this.clockSgn = clock > 0;
      return 0; // set first sample to zero to retrigger gates on step change...
    }
    this.clockSgn = clock > 0;
    return ins[this.step];
  }
}


/**
 * Map of node types to classes
 */
export let NODE_CLASSES =
{
    ADSR: ADSRNode,
    Clock: Clock,
    ClockDiv: ClockDiv,
    ClockOut: ClockOut,
    Delay: Delay,
    Distort: Distort,
    Hold: Hold,
    Noise: NoiseOsc,
    Pulse: PulseOsc,
    Saw: SawOsc,
    Sine: SineOsc,
    Tri: TriOsc,
    // Scope: Scope,
    Slide: Slide,
    Filter: Filter,
    Fold: Fold,
    // MidiIn: MidiIn,
    Seq: Sequence,
};
