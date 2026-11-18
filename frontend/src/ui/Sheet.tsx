// Bottom sheets use the native <dialog> opened with showModal(): the browser traps focus, closes on Escape and blocks
// the page behind. We add the spring animation (CSS) and return focus to the control that opened it.
import { useEffect, useRef, type ReactNode } from "react";
import { IconClose } from "./Icons";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** An id for aria-describedby when the sheet has one key sentence. */
  describedBy?: string;
};

export function Sheet({ open, onClose, title, children, describedBy }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement as HTMLElement | null;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  const handleClose = () => {
    onClose();
    const el = opener.current;
    if (el && document.contains(el)) el.focus();
  };

  return (
    <dialog
      ref={ref}
      className="sheet bc bc-sheet"
      aria-labelledby="sheet-title"
      aria-describedby={describedBy}
      onClose={handleClose}
      onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
    >
      <div className="grab" aria-hidden="true" />
      <div className="sheet-body">
        <div className="sheet-head">
          <h2 id="sheet-title">{title}</h2>
          <button className="close-btn" type="button" onClick={() => ref.current?.close()} aria-label="Close">
            <IconClose />
          </button>
        </div>
        {open ? children : null}
      </div>
    </dialog>
  );
}
