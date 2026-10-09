export default function Loading() {
  return (
    <div className="oc">
      <div className="loading" role="status">
        <span className="pulse" aria-hidden="true" />
        <span className="mono">Loading</span>
      </div>
    </div>
  );
}
