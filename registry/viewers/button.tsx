import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from './utils';

const variants = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  outline: 'border border-border bg-background hover:bg-muted',
  ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
} as const;
// Touch targets: on a phone or any coarse pointer every button is 44px, whatever its desktop size.
const sizes = { sm: 'h-8 gap-1.5 px-3 text-xs max-sm:h-11 pointer-coarse:h-11', icon: 'size-8 max-sm:size-11 pointer-coarse:size-11' } as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: keyof typeof variants;
  readonly size?: keyof typeof sizes;
  readonly ref?: Ref<HTMLButtonElement>;
}

/** shadcn-style button. Always `type="button"` unless a form submit is requested. */
export function Button({ className, variant = 'ghost', size = 'sm', type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors outline-none',
    'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-45 motion-reduce:transition-none',
    variants[variant], sizes[size], className)} {...props} />;
}

/** A bar button: an icon with an accessible name and a tooltip. */
export function IconButton({ label, children, ...props }: { readonly label: string; readonly children: ReactNode } & Omit<ButtonProps, 'size' | 'children'>) {
  return <Button size="icon" aria-label={label} title={label} {...props}>{children}</Button>;
}
