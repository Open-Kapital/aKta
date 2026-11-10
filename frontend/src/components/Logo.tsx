import React from "react";

interface LogoProps {
  isCollapsed: boolean;
}

const Logo = React.forwardRef<HTMLDivElement, LogoProps>(
  ({ isCollapsed }, ref) => {
    if (isCollapsed) {
      return (
        <div
          ref={ref}
          className="flex items-center justify-center mb-2 select-none text-sm font-semibold text-gray-700"
          aria-label="aKta"
        >
          aKta
        </div>
      );
    }
    return (
      <div
        ref={ref}
        className="w-full text-lg text-center border rounded-full bg-blue-50 border-white font-semibold text-gray-700 mb-2 select-none"
        aria-label="aKta"
      >
        <span>aKta</span>
      </div>
    );
  },
);

Logo.displayName = "Logo";

export default Logo;
