import Image from 'next/image';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="ep-auth">
      <div className="ep-auth-side">
        <a href="https://elmamounst.com" className="ep-auth-logo">
          <Image src="/brand/logo.png" alt="Elmamsflow" width={200} height={40} priority />
        </a>
        <div className="ep-auth-pitch">
          <p className="ep-eyebrow">
            <i />
            Your Elmamsflow workspace
          </p>
          <h1>
            Every order.
            <br />
            <span>One calm view.</span>
          </h1>
          <p>Orders, stock, inbounds and support in one place, from our warehouse in China to your customer’s door.</p>
        </div>
        <p className="ep-auth-foot">Access is private and given by the Elmamsflow team.</p>
      </div>
      <main className="ep-auth-main">
        <div className="ep-auth-card">{children}</div>
      </main>
    </div>
  );
}
