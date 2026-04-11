'use client';

// Interfaces
import { IIconTextFieldProps } from '@/lib/utils/interfaces';

// Icons
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

// Prime React
import { InputText } from 'primereact/inputtext';

// Utilities
import { twMerge } from 'tailwind-merge';

// Components
import InputSkeleton from '../custom-skeletons/inputfield.skeleton';

// Styles

export default function CustomIconTextField({
  className,
  iconProperties,
  placeholder,
  showLabel,
  isLoading = false,
  ...props
}: IIconTextFieldProps) {
  const { icon, position, style } = iconProperties;
  const isRight = position === 'right';

  return !isLoading ? (
    <div className="flex flex-col gap-y-1">
      {showLabel && (
        <label htmlFor="username" className="text-sm font-[500]">
          {placeholder}
        </label>
      )}

      <div className="relative">
        <span
          className={twMerge(
            'pointer-events-none absolute top-1/2 -translate-y-1/2 text-gray-500',
            isRight ? 'right-3' : 'left-3'
          )}
          style={style}
        >
          <FontAwesomeIcon icon={icon} />
        </span>

        <InputText
          className={twMerge(
            `h-10 w-full rounded-lg border border-gray-300 text-sm focus:shadow-none focus:outline-none ${isRight ? 'pr-9 pl-2' : 'pl-9 pr-2'}`,
            className
          )}
          placeholder={placeholder}
          {...props}
        />
      </div>
    </div>
  ) : (
    <InputSkeleton />
  );
}
