/** The live toasts (lib/toast.ts) in the kit's `.toast` panel, a check for success and an X for errors, in a polite live region. */
import { useEffect, useState } from 'react';
import { Check, X } from 'lucide';
import { onToasts, type ToastItem } from '../lib/toast';
import { Icon } from './Icon';

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => onToasts(setItems), []);
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast panel toast--${t.tone}`}>
          <Icon node={t.tone === 'success' ? Check : X} size={16} />
          {t.text}
        </div>
      ))}
    </div>
  );
}
