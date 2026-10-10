import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import styles from "./primitives.module.css";

type FieldFrameProps = {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  id?: string;
  className?: string;
  controlClassName?: string;
  "aria-describedby"?: string;
};

function useFieldIds(id: string | undefined, describedBy: string | undefined, hint: ReactNode, error: string | undefined) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  return {
    controlId,
    hintId,
    errorId,
    describedBy: [describedBy, hintId, errorId].filter(Boolean).join(" ") || undefined,
  };
}

function FieldMessage({ hint, error, hintId, errorId }: {
  hint?: ReactNode;
  error?: string;
  hintId?: string;
  errorId?: string;
}) {
  return (
    <>
      {hint && <span className={styles.fieldHint} id={hintId}>{hint}</span>}
      {error && <span className={styles.fieldError} id={errorId}>{error}</span>}
    </>
  );
}

export function TextField({
  label,
  hint,
  error,
  id,
  className,
  controlClassName,
  "aria-describedby": describedBy,
  ...props
}: FieldFrameProps & InputHTMLAttributes<HTMLInputElement>) {
  const ids = useFieldIds(id, describedBy, hint, error);
  return (
    <div className={`${styles.field} ${className ?? ""}`.trim()}>
      <label className={styles.fieldLabel} htmlFor={ids.controlId}>{label}</label>
      <input
        {...props}
        aria-describedby={ids.describedBy}
        aria-invalid={error ? true : undefined}
        className={`${styles.control} ${controlClassName ?? ""}`.trim()}
        id={ids.controlId}
      />
      <FieldMessage error={error} errorId={ids.errorId} hint={hint} hintId={ids.hintId} />
    </div>
  );
}

export function DateTimeField({
  label,
  hint,
  error,
  id,
  className,
  controlClassName,
  "aria-describedby": describedBy,
  ...props
}: FieldFrameProps & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const ids = useFieldIds(id, describedBy, hint, error);
  return (
    <div className={`${styles.field} ${className ?? ""}`.trim()}>
      <label className={styles.fieldLabel} htmlFor={ids.controlId}>{label}</label>
      <input
        {...props}
        aria-describedby={ids.describedBy}
        aria-invalid={error ? true : undefined}
        className={`${styles.control} ${controlClassName ?? ""}`.trim()}
        id={ids.controlId}
        type="datetime-local"
      />
      <FieldMessage error={error} errorId={ids.errorId} hint={hint} hintId={ids.hintId} />
    </div>
  );
}

export function SelectField({
  label,
  hint,
  error,
  id,
  className,
  controlClassName,
  visuallyHiddenLabel = false,
  "aria-describedby": describedBy,
  children,
  ...props
}: FieldFrameProps & SelectHTMLAttributes<HTMLSelectElement> & { visuallyHiddenLabel?: boolean }) {
  const ids = useFieldIds(id, describedBy, hint, error);
  return (
    <div className={`${styles.field} ${className ?? ""}`.trim()}>
      <label className={`${styles.fieldLabel} ${visuallyHiddenLabel ? styles.visuallyHidden : ""}`.trim()} htmlFor={ids.controlId}>{label}</label>
      <select
        {...props}
        aria-describedby={ids.describedBy}
        aria-invalid={error ? true : undefined}
        className={`${styles.control} ${controlClassName ?? ""}`.trim()}
        id={ids.controlId}
      >
        {children}
      </select>
      <FieldMessage error={error} errorId={ids.errorId} hint={hint} hintId={ids.hintId} />
    </div>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  id,
  className,
  controlClassName,
  "aria-describedby": describedBy,
  ...props
}: FieldFrameProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ids = useFieldIds(id, describedBy, hint, error);
  return (
    <div className={`${styles.field} ${className ?? ""}`.trim()}>
      <label className={styles.fieldLabel} htmlFor={ids.controlId}>{label}</label>
      <textarea
        {...props}
        aria-describedby={ids.describedBy}
        aria-invalid={error ? true : undefined}
        className={`${styles.control} ${styles.textarea} ${controlClassName ?? ""}`.trim()}
        id={ids.controlId}
      />
      <FieldMessage error={error} errorId={ids.errorId} hint={hint} hintId={ids.hintId} />
    </div>
  );
}

export function CheckboxField({
  label,
  hint,
  error,
  id,
  className,
  visuallyHiddenLabel = false,
  "aria-describedby": describedBy,
  ...props
}: FieldFrameProps & InputHTMLAttributes<HTMLInputElement> & { visuallyHiddenLabel?: boolean }) {
  const ids = useFieldIds(id, describedBy, hint, error);
  return (
    <label className={`${styles.checkboxField} ${className ?? ""}`.trim()} htmlFor={ids.controlId}>
      <input
        {...props}
        aria-describedby={ids.describedBy}
        aria-invalid={error ? true : undefined}
        id={ids.controlId}
        type="checkbox"
      />
      <span className={styles.checkboxContent}>
        <span className={`${styles.fieldLabel} ${visuallyHiddenLabel ? styles.visuallyHidden : ""}`.trim()}>{label}</span>
        <FieldMessage error={error} errorId={ids.errorId} hint={hint} hintId={ids.hintId} />
      </span>
    </label>
  );
}
