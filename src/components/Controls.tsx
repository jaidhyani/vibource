import { Play, Pause, SkipBack, SkipForward, Minus, Plus } from 'lucide-react';

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
  // Speed is now commits per second (1-20 range)
  const speeds = [1, 2, 5, 10, 20];

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

  const decreaseSpeed = () => {
    const currentIdx = speeds.indexOf(currentSpeed);
    if (currentIdx > 0) {
      onSpeedChange(speeds[currentIdx - 1]);
    } else if (currentIdx === -1) {
      // Find closest lower speed
      const lower = speeds.filter(s => s < currentSpeed);
      if (lower.length > 0) {
        onSpeedChange(lower[lower.length - 1]);
      }
    }
  };

  const increaseSpeed = () => {
    const currentIdx = speeds.indexOf(currentSpeed);
    if (currentIdx >= 0 && currentIdx < speeds.length - 1) {
      onSpeedChange(speeds[currentIdx + 1]);
    } else if (currentIdx === -1) {
      // Find closest higher speed
      const higher = speeds.filter(s => s > currentSpeed);
      if (higher.length > 0) {
        onSpeedChange(higher[0]);
      }
    }
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
            onClick={decreaseSpeed}
            className="control-btn"
            title="Slower"
            disabled={currentSpeed <= speeds[0]}
          >
            <Minus size={20} />
          </button>

          <button
            onClick={onPlayPause}
            className="control-btn play-btn"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause size={24} /> : <Play size={24} />}
          </button>

          <button
            onClick={increaseSpeed}
            className="control-btn"
            title="Faster"
            disabled={currentSpeed >= speeds[speeds.length - 1]}
          >
            <Plus size={20} />
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

        <div className="speed-indicator">
          {speeds.map(speed => (
            <button
              key={speed}
              onClick={() => onSpeedChange(speed)}
              className={`speed-btn ${currentSpeed === speed ? 'active' : ''}`}
            >
              {speed}
            </button>
          ))}
          <span className="speed-label">commits/sec</span>
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
