"use client";

type PasswordVisibilityFieldProps = {
  id?: string;
  name?: string;
  value: string;
  isVisible: boolean;
  onChange: (value: string) => void;
  onToggle?: () => void;
  className?: string;
  required?: boolean;
  readOnly?: boolean;
};

export function PasswordVisibilityField({
  id,
  name,
  value,
  isVisible,
  onChange,
  onToggle,
  className = "field",
  required = false,
  readOnly = false
}: PasswordVisibilityFieldProps) {
  const hasToggle = Boolean(onToggle);

  return (
    <div className="relative">
      <input
        id={id}
        name={name}
        type={isVisible ? "text" : "password"}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${className} ${hasToggle ? "pr-11" : ""}`}
        readOnly={readOnly}
      />
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label={isVisible ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-2 flex items-center px-2 text-zinc-500 transition hover:text-zinc-900"
        >
          {isVisible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      ) : null}
    </div>
  );
}

function EyeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-4.8" />
      <path d="M9.9 4.3A10.5 10.5 0 0 1 12 4.1c6.5 0 10 7.9 10 7.9a17.8 17.8 0 0 1-3.1 4.2" />
      <path d="M6.6 6.6A17.6 17.6 0 0 0 2 12s3.5 7.9 10 7.9a10.7 10.7 0 0 0 4.2-.9" />
    </svg>
  );
}
