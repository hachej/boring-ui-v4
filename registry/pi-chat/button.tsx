import type { ButtonHTMLAttributes } from 'react';
import { cn } from './utils';

const variants = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border border-border bg-background hover:bg-muted',
  ghost: 'hover:bg-muted hover:text-foreground',
  destructive: 'bg-destructive text-white hover:bg-destructive/90',
} as const;
// Touch targets: on a phone or any coarse pointer every button is at least 40px (icon buttons 44px), whatever its desktop size.
const sizes = { sm: 'h-7 gap-1 px-2.5 text-xs max-sm:h-10 pointer-coarse:h-10', md: 'h-9 gap-1.5 px-3.5 text-sm max-sm:h-11 pointer-coarse:h-11', icon: 'size-9 max-sm:size-11 pointer-coarse:size-11', 'icon-sm': 'size-7 max-sm:size-10 pointer-coarse:size-10' } as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: keyof typeof variants;
  readonly size?: keyof typeof sizes;
}

/** shadcn-style button. Always `type="button"` unless a form submit is requested. */
export function Button({ className, variant = 'ghost', size = 'md', type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors outline-none',
    'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-45 motion-reduce:transition-none',
    variants[variant], sizes[size], className)} {...props} />;
}
