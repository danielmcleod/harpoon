// Class-name helper (shadcn idiom): clsx for conditionals, tailwind-merge so a later utility
// overrides an earlier one of the same group (`cn('px-2', props.className)`).
import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
