export default function SceneSeparator() {
  return (
    <div
      role="separator"
      aria-label="Scene break"
      data-testid="scene-separator"
      className="flex items-center justify-center py-8"
    >
      <div className="flex items-center gap-2 text-neutral-500/75" aria-hidden="true">
        <span className="h-px w-10 bg-current opacity-40" />
        <span className="text-sm leading-none">⁂</span>
        <span className="h-px w-10 bg-current opacity-40" />
      </div>
    </div>
  );
}
