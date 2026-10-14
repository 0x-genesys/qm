export async function domSnapshot(page, options = {}) {
  const snapshot = await page.ariaSnapshotJSON({ ...options, mode: "ai" });
  const metadata = new Map();
  function inspect(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(inspect);
    if (node.ref && (node.name || node.text || node.children?.length) && !metadata.has(node.ref)) {
      metadata.set(
        node.ref,
        page.getByRef(node.ref).evaluate(
          (element) => {
            const control = ["input", "textarea"].includes(element.localName);
            let richText = false;
            for (let ancestor = element; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode().host)
              if (ancestor.isContentEditable) richText = true;
            let editableDescendant = false;
            const roots = [element];
            while (roots.length && !editableDescendant) {
              const root = roots.pop();
              if (root.shadowRoot) roots.push(root.shadowRoot);
              for (const child of root.querySelectorAll("*")) {
                if (
                  child.isContentEditable ||
                  (["input", "textarea"].includes(child.localName) &&
                    (child.getAttribute("role") || "")
                      .toLowerCase()
                      .split(/\s+/)
                      .some((role) => ["none", "presentation"].includes(role)))
                ) {
                  editableDescendant = true;
                  break;
                }
                if (child.shadowRoot) roots.push(child.shadowRoot);
              }
            }
            const labelIds = (element.getAttribute("aria-labelledby") || "").trim().split(/\s+/).filter(Boolean);
            const staticLabels =
              labelIds.length &&
              labelIds.every((id) => {
                const label = element.getRootNode().getElementById?.(id);
                return (
                  label &&
                  label !== element &&
                  !label.isContentEditable &&
                  !["input", "textarea"].includes(label.localName) &&
                  !label.querySelector("input, textarea, [contenteditable]")
                );
              });
            return {
              editable: control || richText,
              labeled: Boolean(
                element.getAttribute("aria-label") ||
                staticLabels ||
                (control &&
                  !["button", "submit", "reset"].includes(element.type) &&
                  (element.labels?.length || element.getAttribute("title") || element.getAttribute("placeholder"))),
              ),
              editableDescendant,
            };
          },
          undefined,
          { timeout: options.timeout ?? 5000, signal: options.signal },
        ),
      );
    }
    node.children?.forEach(inspect);
  }
  inspect(snapshot);
  try {
    await Promise.all([...metadata].map(async ([ref, pending]) => metadata.set(ref, await pending)));
  } catch {
    throw new Error("Snapshot redaction failed: a referenced element could not be verified");
  }
  function redact(node, inherited = false) {
    if (typeof node === "string") return inherited && node ? "<redacted>" : node;
    if (Array.isArray(node)) return node.map((child) => redact(child, inherited));
    if (!node || typeof node !== "object") return node;
    const info = metadata.get(node.ref);
    const editable = inherited || info?.editable;
    const result = { ...node };
    if (node.name && editable && (inherited || !info?.labeled)) result.name = "<redacted>";
    if (node.text && (editable || info?.editableDescendant)) result.text = "<redacted>";
    if (node.url && editable) result.url = "<redacted>";
    if (node.children)
      result.children = node.children.map((child) =>
        redact(child, editable || (typeof child === "string" && info?.editableDescendant)),
      );
    return result;
  }
  return JSON.stringify(redact(snapshot), null, 2);
}
