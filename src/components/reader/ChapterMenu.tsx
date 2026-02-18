"use client";

import { motion, AnimatePresence } from "framer-motion";
import type { Chapter } from "@/types/book";

type ChapterMenuProps = {
  isOpen: boolean;
  chapters: Chapter[];
  currentChapterIndex: number | null;
  onSelect: (chapter: Chapter) => void;
  onClose: () => void;
};

export default function ChapterMenu(props: ChapterMenuProps) {
  const { isOpen, chapters, currentChapterIndex, onSelect, onClose } = props;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-30 flex items-start justify-center pt-20"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/60 backdrop-blur-xl"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          
          {/* Menu Container */}
          <motion.div
            className="relative w-full max-w-md mx-4 rounded-3xl bg-neutral-950/95 border border-neutral-800 
              shadow-2xl shadow-black/50 max-h-[60vh] overflow-hidden"
            initial={{ opacity: 0, y: -50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -30, scale: 0.95 }}
            transition={{
              type: "spring",
              stiffness: 300,
              damping: 30
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800/80">
              <h2 className="text-sm font-semibold tracking-tight text-neutral-100">Chapters</h2>
              <motion.button
                type="button"
                onClick={onClose}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="text-xs text-neutral-400 hover:text-neutral-200 px-3 py-1.5 rounded-lg 
                  hover:bg-neutral-800/60 transition-colors duration-150"
              >
                Close
              </motion.button>
            </div>
            
            {/* Chapter List */}
            <div className="max-h-[calc(60vh-4rem)] overflow-y-auto">
              {chapters.length === 0 ? (
                <div className="px-6 py-8 text-sm text-neutral-400 text-center">
                  No chapters detected.
                </div>
              ) : (
                <ul className="py-2">
                  {chapters.map((chapter, i) => {
                    const isActive = currentChapterIndex === chapter.index;
                    return (
                      <motion.li
                        key={chapter.index}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{
                          delay: i * 0.03,
                          duration: 0.2,
                          ease: [0.25, 0.46, 0.45, 0.94]
                        }}
                      >
                        <motion.button
                          type="button"
                          onClick={() => onSelect(chapter)}
                          whileHover={{ backgroundColor: isActive ? "rgba(139, 92, 246, 0.15)" : "rgba(64, 64, 64, 0.5)" }}
                          whileTap={{ scale: 0.98 }}
                          className={`w-full px-6 py-4 text-left transition-colors duration-150 border-l-2 ${
                            isActive
                              ? "bg-violet-500/10 border-violet-500 text-violet-100"
                              : "border-transparent text-neutral-200 hover:bg-neutral-900/50"
                          }`}
                        >
                          <div className={`text-sm font-medium ${
                            isActive ? "text-violet-100" : "text-neutral-200"
                          }`}>
                            {chapter.title}
                          </div>
                        </motion.button>
                      </motion.li>
                    );
                  })}
                </ul>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
