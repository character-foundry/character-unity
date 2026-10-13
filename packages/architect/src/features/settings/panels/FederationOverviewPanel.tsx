export function FederationOverviewPanel() {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="settings-heading">Chat applications</h3>
        <p className="settings-description">Connections are shared with the library. Manage SillyTavern, Lumiverse, and Marinara in the application settings.</p>
      </div>
      <a className="btn-secondary inline-flex" href="/settings#chat-apps">Manage chat connections</a>
      <p className="text-sm text-dark-muted">Save your changes before leaving the editor. Sending and connection status are available from the library and viewer.</p>
    </div>
  );
}
