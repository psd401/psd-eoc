export function AdminNavigation() {
  return (
    <nav aria-label="Administration" className="admin-nav">
      <ul>
        <li>
          <a href="/facilities">Facilities and audiences</a>
        </li>
        <li>
          <a href="/access">Access and roles</a>
        </li>
        <li>
          <a href="/integrations">Integrations and test mode</a>
        </li>
        <li>
          <a href="/emergency">Emergency notification control</a>
        </li>
        <li>
          <a href="/audit">Security audit</a>
        </li>
      </ul>
    </nav>
  );
}
