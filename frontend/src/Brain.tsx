/** Brain = the 3D concept map (frontend/public/brain/, a standalone page on /api/brain/...), filling the
 *  whole content area. Its own toolbar carries "Refresh from Zotero" (the same import the daily job runs). */
export function Brain() {
  return <iframe src="/brain/index.html" title="Brain" className="brain-frame" />;
}
