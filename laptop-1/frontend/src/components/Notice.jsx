// A boxed note for caveats and limitations. `tone`: info | warn
export function Notice({ title, tone = 'info', children }) {
  return (
    <aside className={`notice notice-${tone}`}>
      {title && <p className="notice-title">{title}</p>}
      <div className="notice-body">{children}</div>
    </aside>
  );
}
