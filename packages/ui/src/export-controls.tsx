import { useId, useRef, useState } from 'react';

export function ExportControls({ disabled = false, download, onError, onBusy }: {
  disabled?: boolean;
  download(format: 'json' | 'png' | 'charx' | 'sillytavern-json' | 'sillytavern-png'): Promise<Blob>;
  onError(error: unknown): void;
  onBusy?(busy: boolean): void;
}) {
  const [format, setFormat] = useState<'json' | 'png' | 'charx' | 'sillytavern-json' | 'sillytavern-png'>('json');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const formatId = useId();
  async function run() {
    if (disabled || pending.current) return;
    pending.current = true; setBusy(true); onBusy?.(true);
    try {
      const blob = await download(format);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `character.${format.startsWith('sillytavern-') ? format.slice(12) : format}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { onError(error); }
    finally { pending.current = false; setBusy(false); onBusy?.(false); }
  }
  return <fieldset className="unity-export" disabled={disabled || busy}>
    <legend>Export saved revision</legend>
    <p>Unsaved changes stay in the editor. Exports omit local-only metadata and must preserve content, assets and lineage.</p>
    <label htmlFor={formatId}>Export format</label><select id={formatId} value={format} onChange={(event) => setFormat(event.target.value as typeof format)}>
      <option value="json">JSON</option><option value="png">PNG</option><option value="charx">CharX</option><option value="sillytavern-json">SillyTavern JSON</option><option value="sillytavern-png">SillyTavern PNG</option>
    </select>
    {format === 'sillytavern-json' && <p>For unchanged JSON round trips through SillyTavern. Cards with assets and external content edits are not supported by this profile.</p>}
    {format === 'sillytavern-png' && <p>Portraits and their aliases only. SillyTavern may re-encode the image; reimport rejects changed bytes. Separate attachments require another format.</p>}
    <button onClick={() => { void run(); }}>{busy ? 'Preparing export…' : 'Download saved revision'}</button>
  </fieldset>;
}
