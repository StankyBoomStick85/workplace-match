type FormShellProps = {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
};

export function FormShell({ eyebrow, title, children }: FormShellProps) {
  return (
    <section className="mx-auto max-w-3xl px-4 py-12">
      <div className="rounded-lg border border-line bg-white p-6 shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-clay">
          {eyebrow}
        </p>
        <h1 className="mt-2 text-3xl font-bold">{title}</h1>
        {children}
      </div>
    </section>
  );
}
