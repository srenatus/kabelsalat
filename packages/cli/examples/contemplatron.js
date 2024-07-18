// contemplatron
// by pulu : https://pulusound.fi
let lace = register("lace", (x, ...vals) => {
  let laceProduct = lists => {
    let counters = Array(lists.length).fill(0);
    let first = true;
    let result = [];
    while(first || counters.some(c => c > 0)) {
      result.push(counters.map((c, i) => lists[i][c]));
      counters.forEach((counter, i) => {
        counters[i] = (counter + 1) % lists[i].length;
      });
      first = false;
    }
    return result;
  };

  let laceExpandOnce = list => {
    let sublists = list.filter(x => x.length > 0);
    let sublistIndices = list.map((x, i) => i).filter(i => list[i].length > 0);
    if(sublists.length === 0) {
      return list;
    } else {
      let product = laceProduct(sublists);
      return product.map((productVals, i) => {
        let sublist;
        sublist = [...list];
        sublistIndices.forEach((productIndex, j) => {
          sublist[productIndex] = productVals[j];
        });
        return sublist;
      }).flat();
    }
  };

  let laceExpand = list =>
    laceExpandOnce(list.map(x =>
      Array.isArray(x) ? laceExpand(x) : x
    ));
  return x.seq(...laceExpand(vals));
});

let imp = impulse(6);
let notes = imp.lace([-7,0],3,[[12,10],5,8],3,[5]).add(60+4);
let freq = notes.midinote()
  .mul(imp.ad(0,0.03)
  .bipolar().range(imp.lace(1,1,[2,1],[1,1,2]),0.5))
  .add(sine(
    notes.midinote()
      .mul(imp.lace(2,4,0.5,3,[6,0.25,1,2],1.5)))
      .mul(sine(0.13).rangex(50,800))
  );
let mel = imp.ad(0.01,0.1).mul(sine(freq))
  .add(x => x.delay(5.02/6).mul(0.6));
let bass = imp.lace(1,0,0,1,0,0,[0,0,0,1],0)
  .ad(0.002,0.2).mul(saw(midinote(add(imp.clockdiv(8).lace(-3,-3,-3,[-5,2]).add(36))))
  .lpf(0.3,0.3)).mul(0.7);
let pad = imp.clockdiv(32).apply(g =>
  g.ad(2.5,2.5).pow(1.5).apply(e =>
    e.mul(
      g.lace([3,-4],[[0,5],[-5,0]]).add(72+4)
        .add(e.mul(sine(5)).mul(0.25))
        .midinote().pulse(0.1)
    )
      .lpf(e.range(0.1,0.8),0.2)
      .add(x => x.delay(3.01/6).mul(0.6))
  )
)
  .mul(0.2);
mel.add(bass).add(pad).mul(0.8)
  .out();