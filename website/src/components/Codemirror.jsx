import { EditorView, minimalSetup } from "codemirror";
import { kabelsalatTheme } from "./theme.js";
import { javascript } from "@codemirror/lang-javascript";
import { createEffect } from "solid-js";

export function initEditor({ root, code, onChange, onEvaluate, onStop }) {
  let editor = new EditorView({
    extensions: [
      //basicSetup,
      minimalSetup,
      kabelsalatTheme,
      EditorView.lineWrapping,
      javascript(),
      EditorView.updateListener.of((v) => {
        if (v.docChanged) {
          onChange?.(v.state.doc.toString());
        }
      }),
    ],
    parent: root,
  });
  const setCode = (code) => {
    const changes = {
      from: 0,
      to: editor.state.doc.length,
      insert: code,
    };
    editor.dispatch({ changes });
  };
  setCode(code);

  const getCode = () => editor.state.doc.toString();

  root.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.code === "Enter") {
      onEvaluate?.();
    } else if (e.ctrlKey && e.key === ".") {
      onStop?.();
    }
  });
  return { setCode, getCode, editor };
}

export function Codemirror(props) {
  let cm;
  createEffect(() => {
    if (props.code !== cm.getCode()) {
      cm.setCode(props.code);
    }
  });
  return (
    <div class="resize-none bg-stone-900 shrink-0 focus:ring-0 outline-0 border-0 h-full overflow-hidden">
      <div
        class="w-full max-w-full overflow-hidden h-full"
        ref={(el) => {
          cm = initEditor({
            root: el,
            ...props,
          });
        }}
      ></div>
    </div>
  );
}
