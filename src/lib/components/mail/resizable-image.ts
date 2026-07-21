import Image from "@tiptap/extension-image";

/**
 * Image extension with a drag-to-resize handle. Stores an explicit `width` (px)
 * on the node so it survives autosave / send as `<img style="width:…">`. Built
 * as a plain-DOM NodeView (no framework binding, no extra dependency).
 */
export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const styleW = (el as HTMLElement).style?.width;
          if (styleW) return parseInt(styleW, 10) || null;
          const attrW = el.getAttribute("width");
          return attrW ? parseInt(attrW, 10) || null : null;
        },
        renderHTML: (attrs) =>
          attrs.width ? { style: `width: ${attrs.width}px` } : {},
      },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const wrapper = document.createElement("span");
      wrapper.className = "img-resizer";

      const img = document.createElement("img");
      img.src = node.attrs.src;
      if (node.attrs.alt) img.alt = node.attrs.alt;
      if (node.attrs.title) img.title = node.attrs.title;
      if (node.attrs.width) img.style.width = `${node.attrs.width}px`;
      wrapper.appendChild(img);

      const handle = document.createElement("span");
      handle.className = "img-resize-handle";
      handle.setAttribute("contenteditable", "false");
      wrapper.appendChild(handle);

      let startX = 0;
      let startW = 0;

      const onMove = (e: PointerEvent) => {
        const next = Math.max(40, Math.round(startW + (e.clientX - startX)));
        img.style.width = `${next}px`;
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const width = Math.round(img.getBoundingClientRect().width);
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos != null) {
          editor
            .chain()
            .command(({ tr }) => {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, width });
              return true;
            })
            .run();
        }
      };
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startW = img.getBoundingClientRect().width;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });

      return {
        dom: wrapper,
        // Leaf node — our style mutations shouldn't re-render the view.
        ignoreMutation: () => true,
        update: (updated) => {
          if (updated.type.name !== node.type.name) return false;
          img.src = updated.attrs.src;
          img.style.width = updated.attrs.width ? `${updated.attrs.width}px` : "";
          return true;
        },
      };
    };
  },
});
