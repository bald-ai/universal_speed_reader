
import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";

type ToolItem = {
  id: string;
  label: string;
  icon: React.ReactNode;
  onTap: () => void;
};

type Props = {
  tools: ToolItem[];
};

const PRONUNCIATION_ICON = (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 011.037-.443 48.282 48.282 0 005.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
  </svg>
);

export { PRONUNCIATION_ICON };

export default function ReaderToolsMenu({ tools }: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  if (tools.length === 0) return null;

  return (
    <div className="flex flex-col items-center gap-2">
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            className="flex flex-col items-center gap-1.5"
            initial={shouldReduceMotion ? false : { opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={shouldReduceMotion ? undefined : { opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.18 }}
          >
            {tools.map((tool) => (
              <motion.button
                key={tool.id}
                type="button"
                onClick={() => {
                  tool.onTap();
                  setIsExpanded(false);
                }}
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.96 }}
                className="flex items-center gap-2 rounded-xl bg-neutral-800/80
                  text-neutral-300 text-xs font-medium backdrop-blur-md
                  px-3 py-2 border border-neutral-600/50 hover:border-neutral-500 
                  hover:text-neutral-100 transition-all duration-200 hover:bg-neutral-800 
                  shadow-lg shadow-black/20"
              >
                {tool.icon}
                {tool.label}
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        animate={{ rotate: isExpanded ? 45 : 0 }}
        transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
        className="flex h-8 w-8 items-center justify-center rounded-full 
          bg-neutral-800/60 border border-neutral-700/50 backdrop-blur-md
          text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 
          transition-colors duration-200 shadow-lg shadow-black/20"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </motion.button>
    </div>
  );
}
