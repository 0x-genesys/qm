const valueRoles = new Set(["textbox", "searchbox", "spinbutton", "slider", "combobox"]);

export async function domSnapshot(page, options = {}) {
  const snapshot = await page.ariaSnapshotJSON({ ...options, mode: "ai" });
  function redact(node, valueContext = false) {
    if (typeof node === "string") return valueContext && node ? "<redacted>" : node;
    if (Array.isArray(node)) return node.map((child) => redact(child, valueContext));
    if (!node || typeof node !== "object") return node;
    const result = { ...node };
    const editable = valueRoles.has(node.role);
    if (node.text && (editable || (valueContext && node.role === "text"))) result.text = "<redacted>";
    if (node.children) result.children = redact(node.children, editable);
    return result;
  }
  return JSON.stringify(redact(snapshot), null, 2);
}
