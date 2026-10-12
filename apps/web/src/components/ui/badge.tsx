'use client';

import { type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'info' | 'outline';
  size?: 'sm' | 'md';
}

export function Badge({ className, variant = 'default', size = 'sm', children, ...props }: BadgeProps) {
  const variants = {
    default: 'bg-nebula/20 text-nebula border-nebula/40',
    success: 'bg-aurora/20 text-aurora border-aurora/40',
    warning: 'bg-solar/20 text-solar border-solar/40',
    info: 'bg-cosmic-teal text-starlight border-nebula/40',
    outline: 'bg-transparent text-starlight/80 border-starlight/30',
  };

  const sizes = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-2.5 py-1 text-sm',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center font-medium rounded-full border',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
