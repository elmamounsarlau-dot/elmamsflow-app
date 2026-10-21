import { CopyLink } from './client';
import { linkAge, type AccessLink } from '@/lib/invite';

/** The private sign-in link kept for someone who hasn't chosen a password yet (owner and managers only). */
export function PendingLink({ link, compact }: { link: AccessLink; compact?: boolean }) {
  const age = linkAge(link.created_at);
  return (
    <div className={`ep-pending${age.expired ? ' is-old' : ''}${compact ? ' is-compact' : ''}`}>
      <p className="ep-small">
        {link.emailed ? <span className="ep-st ep-st--ok">Emailed</span> : link.email_error ? <span className="ep-st ep-st--warn">Email not sent</span> : <span className="ep-st ep-st--mute">Copy only</span>}
        <span>Private link · {age.text}. Only you can see this. It works once, then they choose their password.</span>
      </p>
      {link.email_error && <p className="ep-small ep-warn">{link.email_error}</p>}
      {!age.expired && <CopyLink value={link.link} />}
    </div>
  );
}
