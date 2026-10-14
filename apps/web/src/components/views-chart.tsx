/**
 * A minimal daily-views chart.
 *
 * Deliberately hand-drawn SVG rather than a charting library: this is one series
 * of bars, and a dependency would add more bundle weight than the whole page.
 * The underlying numbers are also exposed as a table for screen readers, since a
 * decorative SVG conveys nothing to them.
 */
export function ViewsChart({
  series,
}: {
  series: Array<{ date: string; views: number; likes: number; comments: number }>;
}) {
  const max = Math.max(1, ...series.map((point) => point.views));
  const barWidth = 100 / Math.max(series.length, 1);

  return (
    <figure>
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="h-40 w-full"
        role="img"
        aria-label={`Daily views over the last ${series.length} days, peaking at ${max}.`}
      >
        {series.map((point, index) => {
          const height = (point.views / max) * 38;
          return (
            <rect
              key={point.date}
              x={index * barWidth + barWidth * 0.15}
              y={40 - height}
              width={barWidth * 0.7}
              height={Math.max(height, 0.4)}
              fill="var(--color-accent)"
              opacity={0.85}
            >
              <title>{`${point.date}: ${point.views} views`}</title>
            </rect>
          );
        })}
      </svg>

      <figcaption className="mt-2 flex justify-between text-xs text-[var(--color-text-faint)]">
        <span>{series[0]?.date}</span>
        <span>peak {max.toLocaleString()} views</span>
        <span>{series[series.length - 1]?.date}</span>
      </figcaption>
    </figure>
  );
}
