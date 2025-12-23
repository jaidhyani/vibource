import { Play, Pause, SkipBack, SkipForward } from 'lucide-react';

interface ControlsProps {
  isPlaying: boolean;
  onPlayPause: () => void;
  onSpeedChange: (speed: number) => void;
  currentSpeed: number;
  currentCommitIndex: number;
  totalCommits: number;
  onSeek: (index: number) => void;
  onSkipBack: () => void;
  onSkipForward: () => void;
  currentDate: Date | null;
}

// Speed presets from slow to fast
const SPEED_PRESETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20];

export default function Controls({
  isPlaying,
  onPlayPause,
  onSpeedChange,
  currentSpeed,
  currentCommitIndex,
  totalCommits,
  onSeek,
  onSkipBack,
  onSkipForward,
  currentDate,
}: ControlsProps) {
  const formatDate = (date: Date | null) => {
    if (!date) return '--';
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatTime = (date: Date | null) => {
    if (!date) return '--:--';
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const progress = totalCommits > 0 ? (currentCommitIndex / totalCommits) * 100 : 0;

  // Format speed display
  const formatSpeed = (speed: number) => {
    if (speed >= 1) return speed.toString();
    return speed.toFixed(2).replace(/\.?0+$/, '');
  };

  // Convert speed to slider position (0-100)
  const speedToSlider = (speed: number) => {
    const minLog = Math.log(SPEED_PRESETS[0]);
    const maxLog = Math.log(SPEED_PRESETS[SPEED_PRESETS.length - 1]);
    return ((Math.log(speed) - minLog) / (maxLog - minLog)) * 100;
  };

  // Convert slider position to speed
  const sliderToSpeed = (value: number) => {
    const minLog = Math.log(SPEED_PRESETS[0]);
    const maxLog = Math.log(SPEED_PRESETS[SPEED_PRESETS.length - 1]);
    const speed = Math.exp(minLog + (value / 100) * (maxLog - minLog));
    // Snap to nearest preset if close
    for (const preset of SPEED_PRESETS) {
      if (Math.abs(speed - preset) < preset * 0.15) {
        return preset;
      }
    }
    // Round to reasonable precision
    if (speed < 1) return Math.round(speed * 100) / 100;
    return Math.round(speed);
  };

  return (
    <div className="controls">
      <div className="controls-main">
        <div className="controls-buttons">
          <button
            onClick={onSkipBack}
            className="control-btn"
            title="Previous commit"
            disabled={currentCommitIndex <= 0}
          >
            <SkipBack size={20} />
          </button>

          <button
            onClick={onPlayPause}
            className="control-btn play-btn"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause size={24} /> : <Play size={24} />}
          </button>

          <button
            onClick={onSkipForward}
            className="control-btn"
            title="Next commit"
            disabled={currentCommitIndex >= totalCommits - 1}
          >
            <SkipForward size={20} />
          </button>
        </div>

        <div className="speed-control">
          <div className="speed-slider-container">
            <input
              type="range"
              min={0}
              max={100}
              value={speedToSlider(currentSpeed)}
              onChange={(e) => onSpeedChange(sliderToSpeed(parseFloat(e.target.value)))}
              className="speed-slider"
            />
          </div>
          <div className="speed-display">
            <span className="speed-value">{formatSpeed(currentSpeed)}</span>
            <span className="speed-unit">commits/sec</span>
          </div>
        </div>
      </div>

      <div className="timeline-container">
        <div className="timeline-info">
          <span className="timeline-date">{formatDate(currentDate)}</span>
          <span className="timeline-time">{formatTime(currentDate)}</span>
        </div>

        <div className="timeline-slider">
          <input
            type="range"
            min={0}
            max={Math.max(0, totalCommits - 1)}
            value={currentCommitIndex}
            onChange={(e) => onSeek(parseInt(e.target.value, 10))}
            className="slider"
          />
          <div className="slider-progress" style={{ width: `${progress}%` }} />
        </div>

        <div className="timeline-commits">
          <span>{currentCommitIndex + 1}</span>
          <span className="separator">/</span>
          <span>{totalCommits}</span>
          <span className="label">commits</span>
        </div>
      </div>
    </div>
  );
}
