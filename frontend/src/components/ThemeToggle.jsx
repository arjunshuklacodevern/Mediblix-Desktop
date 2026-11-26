import React from "react";
import { Sun, Moon } from "lucide-react";
import { useTheme } from "../context/ThemeContext";

const ThemeToggle = ({ className = "" }) => {
  const { isDark, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
      title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
      className={`p-2 rounded-xl border transition-all duration-200 cursor-pointer flex items-center justify-center ${
        isDark
          ? "bg-[#192b21] border-[#2a4537] text-amber-300 hover:bg-[#233b2e] hover:text-amber-200 hover:border-amber-400/40 shadow-xs"
          : "bg-white border-gray-200 text-gray-600 hover:bg-gray-100 hover:text-gray-900 shadow-xs"
      } ${className}`}
    >
      {isDark ? (
        <Sun size={17} className="transition-transform duration-200 rotate-0 hover:rotate-45" />
      ) : (
        <Moon size={17} className="transition-transform duration-200 -rotate-12 hover:rotate-0 text-slate-700" />
      )}
    </button>
  );
};

export default ThemeToggle;
