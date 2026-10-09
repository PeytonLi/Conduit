export default function WorkspaceLoading() {
  return (
    <section aria-label="Loading page" data-state="loading">
      <div aria-hidden="true" style={{ minHeight: 80, marginBottom: 16, borderRadius: 10, background: "#e9edf2" }} />
      <div aria-hidden="true" style={{ minHeight: 180, marginBottom: 16, borderRadius: 10, background: "#f1f3f6" }} />
    </section>
  );
}
