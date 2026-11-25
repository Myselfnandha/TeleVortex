import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import type { CinemaVideo } from '@/types';
import { api } from '@/services/api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cleanFileName, formatBytes, formatDuration } from '@/lib/formatters';
import {
  AlertCircle,
  Clapperboard,
  Download,
  ExternalLink,
  Gauge,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Subtitles,
  Tv,
  Volume1,
  Volume2,
  VolumeX,
  Volume2 as AudioTrackIcon,
} from 'lucide-react';

interface VideoPlayerModalProps {
  video: (CinemaVideo & { playback_seconds?: number }) | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNext?: () => void;
  onPrevious?: () => void;
  hasNext?: boolean;
  hasPrevious?: boolean;
}

interface AudioTrackInfo {
  index: number;
  title: string;
  language?: string;
}

interface SubtitleTrackInfo {
  index: number;
  title: string;
  language?: string;
  vtt_url: string;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

const appendAuthToken = (url: string, token: string): string => {
  if (!url || !token || token.length === 64) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
};

interface VideoPlayerSessionProps {
  video: CinemaVideo & { playback_seconds?: number };
  onOpenChange: (open: boolean) => void;
  onNext?: () => void;
  onPrevious?: () => void;
  hasNext: boolean;
  hasPrevious: boolean;
}

const VideoPlayerSession: React.FC<VideoPlayerSessionProps> = ({
  video,
  onOpenChange,
  onNext,
  onPrevious,
  hasNext,
  hasPrevious,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const isDraggingTimeline = useRef(false);

  const isMkvContainer = Boolean(video.is_mkv) || /\.(mkv|avi|ts|flv|wmv|vob)$/i.test(video.filename);
  const resumeTargetSec = video.playback_seconds || (video as any)?.last_position_seconds || 0;

  // Playback & Transport State
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const prevVolumeRef = useRef<number>(1);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [fitMode, setFitMode] = useState<'contain' | 'cover'>('contain');
  const [forceTransmux, setForceTransmux] = useState<boolean>(false);

  const useTransmux = isMkvContainer || forceTransmux;
  const [transmuxSeekSec, setTransmuxSeekSec] = useState<number>(() =>
    isMkvContainer && resumeTargetSec > 5 ? Math.floor(resumeTargetSec) : 0
  );
  const [audioTrackIdx, setAudioTrackIdx] = useState<number>(0);
  const [subTrackIdx, setSubTrackIdx] = useState<number>(0);
  const [audioTracks, setAudioTracks] = useState<AudioTrackInfo[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackInfo[]>([]);

  // Time & Buffer Tracking
  const [currentTimeSec, setCurrentTimeSec] = useState<number>(
    isMkvContainer && resumeTargetSec > 5 ? Math.floor(resumeTargetSec) : 0
  );
  const [bufferedPercent, setBufferedPercent] = useState<number>(0);
  const [bufferSecondsAhead, setBufferSecondsAhead] = useState<number>(0);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  const [measuredDuration, setMeasuredDuration] = useState<number>(0);

  // Subtitles & UI feedback
  const [subtitlesEnabled, setSubtitlesEnabled] = useState<boolean>(true);
  const [osdMessage, setOsdMessage] = useState<string | null>(null);
  const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufferingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const pendingSeekTargetRef = useRef<number | null>(null);

  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [isTriggeringFdm, setIsTriggeringFdm] = useState<boolean>(false);
  const [isLaunchingVlc, setIsLaunchingVlc] = useState<boolean>(false);

  const initialSeekDone = useRef(isMkvContainer && resumeTargetSec > 5);
  const lastReportedTime = useRef(0);

  const duration =
    video.duration && video.duration > 0
      ? video.duration
      : measuredDuration > 0
      ? measuredDuration + (useTransmux ? transmuxSeekSec : 0)
      : 0;

  const storedToken = api.getStoredToken();

  const streamUrl = useMemo(() => {
    const encodedChat = encodeURIComponent(String(video.chat_id));
    if (useTransmux) {
      const base =
        video.stream_transmux_url ||
        `/stream/${encodedChat}/${video.message_id}/${encodeURIComponent(video.filename.replace(/\.[^/.]+$/, '.mp4'))}`;
      const params = new URLSearchParams();
      if (audioTrackIdx > 0) params.set('audio', String(audioTrackIdx));
      if (transmuxSeekSec > 0) params.set('ss', String(transmuxSeekSec));
      const qs = params.toString();
      const withParams = qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}` : base;
      return appendAuthToken(withParams, storedToken);
    }
    const directBase = `/dl/${encodedChat}/${video.message_id}/${encodeURIComponent(video.filename)}`;
    return appendAuthToken(directBase, storedToken);
  }, [video.chat_id, video.message_id, video.filename, video.stream_transmux_url, useTransmux, audioTrackIdx, transmuxSeekSec, storedToken]);

  const subtitleUrl = useMemo(() => {
    const activeSub = subtitleTracks.find((s) => s.index === subTrackIdx);
    const base =
      activeSub?.vtt_url ||
      `/api/media/subtitles/${encodeURIComponent(String(video.chat_id))}/${video.message_id}/${subTrackIdx}.vtt`;
    return appendAuthToken(base, storedToken);
  }, [video.chat_id, video.message_id, subTrackIdx, subtitleTracks, storedToken]);

  const displayName = cleanFileName(video.filename);

  const showOsd = useCallback((msg: string) => {
    setOsdMessage(msg);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    osdTimerRef.current = setTimeout(() => setOsdMessage(null), 1500);
  }, []);

  const clearBufferingTimers = useCallback(() => {
    if (bufferingTimerRef.current) {
      clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
    if (stallRecoveryTimerRef.current) {
      clearTimeout(stallRecoveryTimerRef.current);
      stallRecoveryTimerRef.current = null;
    }
    setIsBuffering(false);
  }, []);

  useEffect(() => {
    api.prewarmMedia(video.chat_id, video.message_id).catch(() => {});

    let cancelled = false;
    const probeTimer = setTimeout(() => {
      api
        .probeMediaStreams(video.chat_id, video.message_id)
        .then((res) => {
          if (cancelled) return;
          if (Array.isArray(res.audio_tracks)) setAudioTracks(res.audio_tracks);
          if (Array.isArray(res.subtitle_tracks)) setSubtitleTracks(res.subtitle_tracks);
        })
        .catch(() => {});
    }, 800);

    return () => {
      cancelled = true;
      clearTimeout(probeTimer);
    };
  }, [video.chat_id, video.message_id]);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
      if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current);
      clearBufferingTimers();
      dragCleanupRef.current?.();
    };
  }, [clearBufferingTimers]);

  const syncProgress = useCallback(
    (seconds: number, keepalive: boolean = false) => {
      if (seconds <= 0) return;
      const dur = duration > 0 ? duration : 0;
      const fileSize = video.size || video.file_size || 0;
      const ratio = dur > 0 ? seconds / dur : 0;
      const approxBytes = Math.floor(ratio * fileSize);
      const chunkIdx = Math.floor(approxBytes / (512 * 1024));

      api
        .updatePlaybackProgress(
          {
            chat_id: video.chat_id,
            message_id: video.message_id,
            filename: video.filename,
            position_seconds: seconds,
            duration_seconds: dur,
            file_size: fileSize,
            thumbnail_url: video.thumb_url,
            last_chunk_index: chunkIdx,
            last_byte_offset: approxBytes,
          },
          keepalive
        )
        .catch(() => {});
    },
    [video, duration]
  );

  const syncProgressRef = useRef(syncProgress);
  const resumeStateRef = useRef({ transmuxSeekSec, useTransmux });
  useEffect(() => {
    syncProgressRef.current = syncProgress;
    resumeStateRef.current = { transmuxSeekSec, useTransmux };
  }, [syncProgress, transmuxSeekSec, useTransmux]);

  const attemptResume = useCallback(() => {
    if (initialSeekDone.current || !videoRef.current || resumeTargetSec <= 5) return;
    if (useTransmux) {
      initialSeekDone.current = true;
      const targetSec = Math.floor(resumeTargetSec);
      setTransmuxSeekSec(targetSec);
      setCurrentTimeSec(targetSec);
      showOsd(`Resumed at ${formatDuration(resumeTargetSec)}`);
      return;
    }
    try {
      videoRef.current.currentTime = resumeTargetSec;
      initialSeekDone.current = true;
      showOsd(
        `Resumed at ${formatDuration(resumeTargetSec)}${
          video.last_chunk_index ? ` (Chunk #${video.last_chunk_index})` : ''
        }`
      );
    } catch (e) {
      console.debug('Resume seek deferred:', e);
    }
  }, [resumeTargetSec, useTransmux, video.last_chunk_index, showOsd]);

  const handleLoadedMetadata = () => {
    setPlaybackError(null);
    clearBufferingTimers();
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
      videoRef.current.playbackRate = playbackRate;
      const d = videoRef.current.duration;
      if (isFinite(d) && d > 0) {
        setMeasuredDuration(d);
      }
    }
    attemptResume();
  };

  const handleDurationChange = () => {
    const d = videoRef.current?.duration;
    if (d && isFinite(d) && d > 0) {
      setMeasuredDuration(d);
    }
  };

  const handleCanPlay = () => {
    clearBufferingTimers();
    if (!initialSeekDone.current && resumeTargetSec > 5) {
      attemptResume();
    }
  };

  const updateBufferStatus = () => {
    const v = videoRef.current;
    if (!v) return;
    const dur = duration > 0 ? duration : 1;
    const offset = useTransmux ? transmuxSeekSec : 0;
    if (v.buffered.length > 0) {
      const maxEnd = v.buffered.end(v.buffered.length - 1);
      setBufferedPercent(Math.min(100, Math.round(((offset + maxEnd) / dur) * 100)));
      setBufferSecondsAhead(Math.max(0, Math.round(maxEnd - v.currentTime)));
    }
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    clearBufferingTimers();
    const offset = useTransmux ? transmuxSeekSec : 0;
    const current = Math.floor(offset + v.currentTime);
    setCurrentTimeSec(current);

    if (resumeTargetSec > 10 && !initialSeekDone.current && current < 10) {
      return;
    }

    if (Math.abs(current - lastReportedTime.current) >= 5 && current > 0) {
      lastReportedTime.current = current;
      syncProgress(current);
    }

    updateBufferStatus();
  };

  const handleWaitingOrStalled = () => {
    const v = videoRef.current;
    if (!v || v.paused) return;

    if (!bufferingTimerRef.current) {
      bufferingTimerRef.current = setTimeout(() => {
        setIsBuffering(true);
      }, 600);
    }

    if (!stallRecoveryTimerRef.current) {
      stallRecoveryTimerRef.current = setTimeout(() => {
        const cur = videoRef.current;
        if (!cur || cur.paused) return;
        const pos = Math.floor((useTransmux ? transmuxSeekSec : 0) + cur.currentTime);
        showOsd('Recovering stalled stream...');
        if (useTransmux) {
          setTransmuxSeekSec(pos);
        } else {
          cur.load();
          try {
            cur.currentTime = pos;
          } catch {}
          cur.play().catch(() => {});
        }
      }, 10000);
    }
  };

  const handleNextClick = useCallback(() => {
    if (currentTimeSec > 5) {
      syncProgress(Math.floor(currentTimeSec));
    }
    if (onNext) onNext();
  }, [currentTimeSec, syncProgress, onNext]);

  const handlePrevClick = useCallback(() => {
    if (currentTimeSec > 5) {
      syncProgress(Math.floor(currentTimeSec));
    }
    if (onPrevious) onPrevious();
  }, [currentTimeSec, syncProgress, onPrevious]);

  const handleEnded = () => {
    clearBufferingTimers();
    api.removeContinueWatching(video.chat_id, video.message_id).catch(() => {});
    if (onNext && hasNext) {
      showOsd('Playing next video...');
      onNext();
    } else {
      setIsPlaying(false);
      showOsd('Completed playback');
    }
  };

  const handleSeek = useCallback(
    (targetSec: number, immediate: boolean = false) => {
      const total = duration > 0 ? duration : 999999;
      const bounded = Math.max(0, Math.min(total, targetSec));
      pendingSeekTargetRef.current = bounded;
      setCurrentTimeSec(bounded);
      showOsd(`Seek: ${formatDuration(Math.floor(bounded))}`);

      if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current);
      const applySeek = () => {
        const target = pendingSeekTargetRef.current !== null ? pendingSeekTargetRef.current : bounded;
        pendingSeekTargetRef.current = null;
        const v = videoRef.current;
        if (!v) return;

        if (useTransmux) {
          const relTarget = target - transmuxSeekSec;
          let isWithinBuffered = false;
          if (relTarget >= 0) {
            for (let i = 0; i < v.buffered.length; i++) {
              if (relTarget >= v.buffered.start(i) && relTarget <= v.buffered.end(i)) {
                isWithinBuffered = true;
                break;
              }
            }
          }
          if (isWithinBuffered) {
            v.currentTime = relTarget;
            v.play().catch(() => {});
            setIsPlaying(true);
          } else {
            const nextStart = Math.max(0, Math.floor(target));
            setTransmuxSeekSec(nextStart);
            setCurrentTimeSec(nextStart);
            setIsPlaying(true);
          }
          return;
        }

        v.currentTime = target;
        v.play().catch(() => {});
        setIsPlaying(true);
      };

      if (immediate) {
        applySeek();
      } else {
        seekDebounceRef.current = setTimeout(applySeek, 150);
      }
    },
    [duration, showOsd, useTransmux, transmuxSeekSec]
  );

  const handleSeekDelta = useCallback(
    (deltaSec: number) => {
      const offset = useTransmux ? transmuxSeekSec : 0;
      const currentBase =
        pendingSeekTargetRef.current !== null
          ? pendingSeekTargetRef.current
          : offset + (videoRef.current?.currentTime ?? currentTimeSec - offset);
      handleSeek(currentBase + deltaSec, false);
    },
    [currentTimeSec, handleSeek, transmuxSeekSec, useTransmux]
  );

  const togglePlayPause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
      setIsPlaying(true);
      showOsd('Play');
    } else {
      v.pause();
      setIsPlaying(false);
      showOsd('Pause');
    }
  }, [showOsd]);

  const handleVolumeChange = useCallback(
    (newVol: number) => {
      const bounded = Math.max(0, Math.min(1, Math.round(newVol * 100) / 100));
      setVolume(bounded);
      if (videoRef.current) {
        videoRef.current.volume = bounded;
        videoRef.current.muted = bounded === 0;
      }
      setIsMuted(bounded === 0);
      showOsd(`Volume ${Math.round(bounded * 100)}%`);
    },
    [showOsd]
  );

  const toggleMute = useCallback(() => {
    if (!videoRef.current) return;
    if (isMuted || volume === 0) {
      const next = prevVolumeRef.current > 0 ? prevVolumeRef.current : 1;
      videoRef.current.muted = false;
      videoRef.current.volume = next;
      setVolume(next);
      setIsMuted(false);
      showOsd(`Unmuted (${Math.round(next * 100)}%)`);
    } else {
      prevVolumeRef.current = volume;
      videoRef.current.muted = true;
      setIsMuted(true);
      showOsd('Muted');
    }
  }, [isMuted, volume, showOsd]);

  const handleRateChange = useCallback(
    (nextRate: number) => {
      const clamped = Math.max(0.5, Math.min(2, nextRate));
      setPlaybackRate(clamped);
      if (videoRef.current) {
        videoRef.current.playbackRate = clamped;
      }
      showOsd(`Speed ${clamped}x`);
    },
    [showOsd]
  );

  const cyclePlaybackRate = useCallback(() => {
    const idx = PLAYBACK_RATES.indexOf(playbackRate);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    handleRateChange(next);
  }, [playbackRate, handleRateChange]);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  }, []);

  const togglePip = async () => {
    const v = videoRef.current;
    if (!v || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        showOsd('Exited PiP');
      } else {
        await v.requestPictureInPicture();
        showOsd('Picture-in-Picture');
      }
    } catch {}
  };

  const toggleFitMode = useCallback(() => {
    setFitMode((prev) => {
      const next = prev === 'contain' ? 'cover' : 'contain';
      showOsd(next === 'cover' ? 'Fit: Zoom to Fill' : 'Fit: Original 16:9');
      return next;
    });
  }, [showOsd]);

  const handleToggleSubtitles = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const track = v.textTracks[0];
    if (track) {
      const next = !subtitlesEnabled;
      track.mode = next ? 'showing' : 'hidden';
      setSubtitlesEnabled(next);
      showOsd(next ? 'Subtitles ON' : 'Subtitles OFF');
    }
  }, [subtitlesEnabled, showOsd]);

  const handleCycleAudioTrack = () => {
    if (audioTracks.length <= 1) return;
    const nextIdx = (audioTrackIdx + 1) % audioTracks.length;
    const resumeAt = Math.floor(currentTimeSec);
    setForceTransmux(true);
    setAudioTrackIdx(nextIdx);
    setTransmuxSeekSec(resumeAt);
    showOsd(`Audio: ${audioTracks[nextIdx]?.title || `Track ${nextIdx + 1}`}`);
  };

  const handleCycleSubtitleTrack = () => {
    if (subtitleTracks.length <= 1) {
      handleToggleSubtitles();
      return;
    }
    const nextIdx = (subTrackIdx + 1) % subtitleTracks.length;
    setSubTrackIdx(nextIdx);
    setSubtitlesEnabled(true);
    showOsd(`Subtitles: ${subtitleTracks[nextIdx]?.title || `Track ${nextIdx + 1}`}`);
  };

  // Timeline Scrubbing Handlers
  const calculateTimelineTime = (clientX: number) => {
    if (!timelineRef.current || duration <= 0) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(pos * duration);
  };

  const handleTimelineMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || duration <= 0) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverPct(pos * 100);
    setHoverTime(Math.round(pos * duration));
  };

  const handleTimelineMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    isDraggingTimeline.current = true;
    const initialTarget = calculateTimelineTime(e.clientX);
    setCurrentTimeSec(initialTarget);

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (isDraggingTimeline.current && timelineRef.current && duration > 0) {
        const rect = timelineRef.current.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width));
        const t = Math.round(pos * duration);
        setHoverPct(pos * 100);
        setHoverTime(t);
        setCurrentTimeSec(t);
      }
    };

    const cleanupDrag = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (dragCleanupRef.current === cleanupDrag) {
        dragCleanupRef.current = null;
      }
    };

    const onMouseUp = (upEvent: MouseEvent) => {
      if (isDraggingTimeline.current) {
        isDraggingTimeline.current = false;
        const finalTarget = calculateTimelineTime(upEvent.clientX);
        handleSeek(finalTarget);
      }
      cleanupDrag();
    };

    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanupDrag;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleTimelineMouseLeave = () => {
    if (!isDraggingTimeline.current) {
      setHoverTime(null);
      setHoverPct(null);
    }
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches[0]) {
      const target = calculateTimelineTime(e.touches[0].clientX);
      handleSeek(target);
    }
  };

  const handleTimelineKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    let targetTime: number | null = null;
    switch (e.key) {
      case 'Home':
        e.preventDefault();
        e.stopPropagation();
        targetTime = 0;
        break;
      case 'End':
        e.preventDefault();
        e.stopPropagation();
        targetTime = duration;
        break;
      case 'PageUp':
        e.preventDefault();
        e.stopPropagation();
        targetTime = Math.min(duration, currentTimeSec + 60);
        break;
      case 'PageDown':
        e.preventDefault();
        e.stopPropagation();
        targetTime = Math.max(0, currentTimeSec - 60);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        targetTime = Math.min(duration, currentTimeSec + (e.shiftKey ? 15 : 5));
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        targetTime = Math.max(0, currentTimeSec - (e.shiftKey ? 15 : 5));
        break;
    }
    if (targetTime !== null) {
      handleSeek(targetTime, true);
    }
  };

  // Keyboard navigation shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
      const v = videoRef.current;
      if (!v) return;

      if (e.code === 'Space' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.key === 'Home') {
        e.preventDefault();
        handleSeek(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        if (duration > 0) handleSeek(duration);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        handleSeekDelta(60);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        handleSeekDelta(-60);
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j') {
        e.preventDefault();
        handleSeekDelta(e.shiftKey ? -30 : -10);
      } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') {
        e.preventDefault();
        handleSeekDelta(e.shiftKey ? 30 : 10);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        handleVolumeChange(volume + 0.05);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleVolumeChange(volume - 0.05);
      } else if (e.key === '[') {
        e.preventDefault();
        handleRateChange(playbackRate - 0.25);
      } else if (e.key === ']') {
        e.preventDefault();
        handleRateChange(playbackRate + 0.25);
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        toggleMute();
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key.toLowerCase() === 'c') {
        e.preventDefault();
        handleToggleSubtitles();
      } else if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        toggleFitMode();
      } else if (e.shiftKey && e.key.toLowerCase() === 'n') {
        if (onNext && hasNext) {
          e.preventDefault();
          handleNextClick();
        }
      } else if (e.shiftKey && e.key.toLowerCase() === 'p') {
        if (onPrevious && hasPrevious) {
          e.preventDefault();
          handlePrevClick();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    duration,
    volume,
    playbackRate,
    onNext,
    onPrevious,
    hasNext,
    hasPrevious,
    togglePlayPause,
    handleSeek,
    handleSeekDelta,
    handleVolumeChange,
    handleRateChange,
    toggleMute,
    toggleFullscreen,
    handleToggleSubtitles,
    toggleFitMode,
    handleNextClick,
    handlePrevClick,
  ]);

  const handleLaunchInVlc = async () => {
    setIsLaunchingVlc(true);
    if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current);
    try {
      const currentSec = Math.floor(
        (useTransmux ? transmuxSeekSec : 0) + (videoRef.current?.currentTime || 0)
      );
      syncProgress(currentSec || currentTimeSec);
      if (videoRef.current) {
        try {
          videoRef.current.pause();
        } catch {}
      }

      const fullHttpUrl = appendAuthToken(
        `${window.location.origin}/dl/${encodeURIComponent(String(video.chat_id))}/${video.message_id}/${encodeURIComponent(video.filename)}`,
        storedToken
      );

      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      const isRemote = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';

      if (isMobile || isRemote) {
        window.location.href = `vlc://${fullHttpUrl}`;
        showOsd('Opening in VLC App...');
        setTimeout(() => onOpenChange(false), 1200);
        return;
      }

      await api.launchVlc(video.chat_id, video.message_id, video.filename);
      onOpenChange(false);
    } catch (err: any) {
      showOsd(err?.message || 'Failed to launch VLC');
    } finally {
      setIsLaunchingVlc(false);
    }
  };

  const handleTriggerFdm = async () => {
    setIsTriggeringFdm(true);
    const fullUrl = appendAuthToken(
      `${window.location.origin}/dl/${encodeURIComponent(String(video.chat_id))}/${video.message_id}/${encodeURIComponent(video.filename)}`,
      storedToken
    );
    try {
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      const isRemote = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';

      if (isMobile || isRemote) {
        await navigator.clipboard.writeText(fullUrl).catch(() => {});
        showOsd('FDM URL Copied');
        return;
      }

      const res = await api.triggerFdm(video.chat_id, video.message_id, video.filename);
      if (res && res.success) {
        showOsd('Dispatched to FDM');
      } else {
        await navigator.clipboard.writeText(fullUrl).catch(() => {});
        showOsd('FDM URL Copied');
      }
    } catch {
      await navigator.clipboard.writeText(fullUrl).catch(() => {});
      showOsd('FDM Link Copied');
    } finally {
      setIsTriggeringFdm(false);
    }
  };

  useEffect(() => {
    const v = videoRef.current;
    const flushProgress = () => {
      const target = videoRef.current || v;
      if (!target) return;
      const { transmuxSeekSec: seekOffset, useTransmux: isTransmux } = resumeStateRef.current;
      const watched = Math.floor((isTransmux ? seekOffset : 0) + (target.currentTime || 0));
      if (watched > 0) {
        syncProgressRef.current(watched, true);
      }
    };

    window.addEventListener('pagehide', flushProgress);
    window.addEventListener('beforeunload', flushProgress);

    return () => {
      window.removeEventListener('pagehide', flushProgress);
      window.removeEventListener('beforeunload', flushProgress);
      flushProgress();
      if (v) {
        try {
          v.pause();
          v.removeAttribute('src');
          v.load();
        } catch {}
      }
    };
  }, []);

  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTimeSec / duration) * 100)) : 0;
  const downloadHref = appendAuthToken(
    `/dl/${encodeURIComponent(String(video.chat_id))}/${video.message_id}/${encodeURIComponent(video.filename)}`,
    storedToken
  );

  return (
    <DialogContent className="sm:max-w-4xl bg-black/95 border-border/60 p-0 overflow-hidden shadow-2xl">
      <style>{`
        .cinema-video-player::cue {
          font-size: 17px;
          background: rgba(0, 0, 0, 0.85);
          color: #ffffff;
          border-radius: 4px;
          padding: 3px 10px;
          text-shadow: 0 1px 3px rgba(0,0,0,0.9);
        }
      `}</style>

      {/* Modal Header */}
      <DialogHeader className="p-3.5 border-b border-white/10 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 pr-4">
          <Clapperboard className="w-4 h-4 text-primary shrink-0" />
          <DialogTitle className="text-sm font-semibold text-white truncate max-w-xl" title={video.filename}>
            {displayName}
          </DialogTitle>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleLaunchInVlc}
          disabled={isLaunchingVlc}
          className="h-7 px-2.5 text-xs gap-1.5 border-white/20 bg-white/5 hover:bg-white/10 text-white cursor-pointer shrink-0"
          title="Switch playback seamlessly to VLC Desktop"
        >
          <Tv className="w-3.5 h-3.5 text-amber-400" />
          <span>{isLaunchingVlc ? 'Launching...' : 'Play in VLC'}</span>
        </Button>
      </DialogHeader>

      {/* Video Player Container */}
      <div
        ref={containerRef}
        className="relative aspect-video bg-black flex items-center justify-center overflow-hidden group select-none"
      >
        {osdMessage && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 px-3.5 py-1 rounded-full bg-black/85 text-white text-xs font-mono font-medium border border-white/20 shadow-xl backdrop-blur-md animate-in fade-in zoom-in-95 pointer-events-none">
            {osdMessage}
          </div>
        )}

        {isBuffering && !playbackError && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
            <div className="px-3.5 py-2 rounded-full bg-black/80 border border-white/15 text-white text-xs font-mono flex items-center gap-2 shadow-xl backdrop-blur-md">
              <Loader2 className="w-4 h-4 text-primary animate-spin" />
              <span>Buffering stream...</span>
            </div>
          </div>
        )}

        {playbackError && (
          <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center p-6 text-center space-y-3 z-30 animate-in fade-in">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/20 text-amber-400 flex items-center justify-center">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div className="space-y-1 max-w-md">
              <h3 className="text-sm font-semibold text-white">Playback Interrupted</h3>
              <p className="text-xs text-zinc-400">{playbackError}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => {
                  setPlaybackError(null);
                  if (videoRef.current) {
                    videoRef.current.load();
                    videoRef.current.play().catch(() => {});
                  }
                }}
                className="bg-primary text-primary-foreground gap-1.5 text-xs h-8 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Retry Playback</span>
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await api.launchVlc(video.chat_id, video.message_id, video.filename);
                    showOsd('Launched in Desktop VLC');
                  } catch (e) {
                    console.debug('Failed to launch VLC:', e);
                  }
                }}
                className="border-white/20 text-white gap-1.5 text-xs h-8 cursor-pointer"
              >
                <Tv className="w-3.5 h-3.5 text-amber-400" />
                <span>Launch VLC</span>
              </Button>
            </div>
          </div>
        )}

        <video
          key={streamUrl}
          ref={videoRef}
          src={streamUrl}
          autoPlay
          playsInline
          onClick={togglePlayPause}
          className={`w-full h-full ${fitMode === 'cover' ? 'object-cover' : 'object-contain'} cinema-video-player cursor-pointer`}
          preload="auto"
          onLoadedMetadata={handleLoadedMetadata}
          onDurationChange={handleDurationChange}
          onCanPlay={handleCanPlay}
          onPlaying={clearBufferingTimers}
          onWaiting={handleWaitingOrStalled}
          onStalled={handleWaitingOrStalled}
          onTimeUpdate={handleTimeUpdate}
          onProgress={updateBufferStatus}
          onPlay={() => setIsPlaying(true)}
          onPause={() => {
            setIsPlaying(false);
            syncProgress(Math.floor(currentTimeSec));
          }}
          onEnded={handleEnded}
          onError={() => {
            clearBufferingTimers();
            if (!useTransmux) {
              setForceTransmux(true);
              showOsd('Auto-switching to real-time transmuxed stream...');
            } else {
              setPlaybackError('The browser could not decode this media stream. Open in Desktop VLC or download directly.');
            }
          }}
        >
          <track
            key={subtitleUrl}
            label={subtitleTracks.find((s) => s.index === subTrackIdx)?.title || 'Default Subtitles'}
            kind="subtitles"
            srcLang={subtitleTracks.find((s) => s.index === subTrackIdx)?.language || 'en'}
            src={subtitleUrl}
            default
          />
          Your browser does not support HTML5 video streaming.
        </video>
      </div>

      {/* Interactive Scrubbing Timeline Bar */}
      <div className="bg-zinc-950 px-4 pt-3 pb-1.5 border-t border-white/10 select-none">
        <div
          ref={timelineRef}
          role="slider"
          tabIndex={0}
          aria-label="Video scrubber timeline"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={duration > 0 ? duration : 0}
          aria-valuenow={currentTimeSec}
          aria-valuetext={`${formatDuration(currentTimeSec)} of ${formatDuration(duration)}`}
          onKeyDown={handleTimelineKeyDown}
          onMouseDown={handleTimelineMouseDown}
          onMouseMove={handleTimelineMouseMove}
          onMouseLeave={handleTimelineMouseLeave}
          onTouchStart={handleTouchStart}
          className="group/timeline relative w-full h-3 flex items-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 rounded-sm"
        >
          {hoverTime !== null && hoverPct !== null && (
            <div
              style={{ left: `${Math.min(94, Math.max(6, hoverPct))}%` }}
              className="absolute -top-7 -translate-x-1/2 px-2 py-0.5 rounded bg-zinc-900 border border-white/20 text-white text-[10px] font-mono shadow-lg pointer-events-none z-30 whitespace-nowrap"
            >
              {formatDuration(hoverTime)}
              {(() => {
                const fileSize = video.size || (video as any)?.file_size || 0;
                if (duration > 0 && fileSize > 0) {
                  const hoverBytes = Math.floor((hoverTime / duration) * fileSize);
                  const hoverChunk = Math.floor(hoverBytes / (512 * 1024));
                  return ` • Chunk ${hoverChunk}`;
                }
                return '';
              })()}
            </div>
          )}

          <div className="w-full h-1.5 group-hover/timeline:h-2 rounded-full bg-zinc-800 transition-all overflow-hidden relative">
            <div
              className="absolute top-0 bottom-0 left-0 bg-emerald-500/40 transition-all duration-300"
              style={{ width: `${bufferedPercent}%` }}
              title={`Buffered: ${bufferedPercent}%`}
            />
            <div
              className="absolute top-0 bottom-0 left-0 bg-primary h-full transition-all duration-75"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          <div
            className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-md ring-2 ring-primary transition-transform opacity-0 group-hover/timeline:opacity-100 group-hover/timeline:scale-110 pointer-events-none"
            style={{ left: `calc(${progressPercent}% - 7px)` }}
          />
        </div>
      </div>

      {/* Transport Controls Toolbar */}
      <div className="px-4 py-2.5 bg-zinc-950/95 flex flex-wrap items-center justify-between gap-3 text-xs border-t border-white/5 select-none">
        <div className="flex items-center gap-1.5">
          {onPrevious && (
            <button
              onClick={handlePrevClick}
              disabled={!hasPrevious}
              aria-label="Previous video (Shift+P)"
              className="w-8 h-8 rounded-lg bg-zinc-900 border border-white/10 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-300 hover:text-white flex items-center justify-center transition-all active:scale-95 cursor-pointer"
              title="Previous video (Shift+P)"
            >
              <SkipBack className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            onClick={togglePlayPause}
            aria-label={isPlaying ? 'Pause video (Space or K)' : 'Play video (Space or K)'}
            className="w-8 h-8 rounded-lg bg-primary text-primary-foreground hover:opacity-90 flex items-center justify-center transition-all active:scale-95 cursor-pointer shadow-md"
            title={isPlaying ? 'Pause (Space or K)' : 'Play (Space or K)'}
          >
            {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
          </button>

          {onNext && (
            <button
              onClick={handleNextClick}
              disabled={!hasNext}
              aria-label="Next video (Shift+N)"
              className="w-8 h-8 rounded-lg bg-zinc-900 border border-white/10 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-300 hover:text-white flex items-center justify-center transition-all active:scale-95 cursor-pointer"
              title="Next video (Shift+N)"
            >
              <SkipForward className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            onClick={() => handleSeekDelta(-10)}
            aria-label="Seek back 10 seconds (Left Arrow or J)"
            className="w-8 h-8 rounded-lg bg-zinc-900 border border-white/10 hover:bg-zinc-800 text-zinc-300 hover:text-white flex items-center justify-center transition-all active:scale-95 cursor-pointer"
            title="Seek back 10s (Left Arrow or J)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => handleSeekDelta(10)}
            aria-label="Seek forward 10 seconds (Right Arrow or L)"
            className="w-8 h-8 rounded-lg bg-zinc-900 border border-white/10 hover:bg-zinc-800 text-zinc-300 hover:text-white flex items-center justify-center transition-all active:scale-95 cursor-pointer"
            title="Seek forward 10s (Right Arrow or L)"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>

          {currentTimeSec > 30 && (
            <button
              onClick={() => {
                handleSeek(0, true);
                api
                  .updatePlaybackProgress({
                    chat_id: video.chat_id,
                    message_id: video.message_id,
                    filename: video.filename,
                    position_seconds: 0,
                    duration_seconds: duration,
                  })
                  .catch(() => {});
                showOsd('Restarted from beginning');
              }}
              aria-label="Restart from 0:00"
              className="px-2 h-8 rounded-lg bg-zinc-900 border border-white/10 hover:bg-zinc-800 text-zinc-300 hover:text-white flex items-center justify-center transition-all active:scale-95 cursor-pointer text-[10px] font-mono"
              title="Restart from 0:00"
            >
              0:00
            </button>
          )}

          <div className="flex items-center gap-1 pl-2 border-l border-white/10">
            <button
              onClick={toggleMute}
              aria-label={isMuted ? 'Unmute (M)' : 'Mute (M)'}
              className="w-7 h-7 rounded hover:bg-zinc-800 text-zinc-300 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
              title="Toggle Mute (M)"
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="w-4 h-4 text-red-400" />
              ) : volume < 0.5 ? (
                <Volume1 className="w-4 h-4" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              aria-label="Volume Slider"
              className="w-16 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-primary"
              title={`Volume: ${isMuted ? 0 : Math.round(volume * 100)}%`}
            />
          </div>

          <div className="pl-2 font-mono text-[11px] text-zinc-400 select-none">
            <span className="text-white font-medium">{formatDuration(currentTimeSec)}</span>
            <span className="text-zinc-600 mx-1">/</span>
            <span>{formatDuration(duration)}</span>
          </div>
        </div>

        {/* Right: Speed, Tracks, CC, Fit, PiP, Fullscreen, Download, FDM */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={cyclePlaybackRate}
            aria-label={`Playback speed ${playbackRate}x`}
            className="px-2 py-1 rounded bg-zinc-900 border border-white/10 hover:bg-zinc-800 text-zinc-200 font-mono text-[11px] font-bold flex items-center gap-1 cursor-pointer"
            title="Cycle Playback Speed ([ or ])"
          >
            <Gauge className="w-3 h-3 text-sky-400" />
            <span>{playbackRate}x</span>
          </button>

          {audioTracks.length > 1 && (
            <button
              onClick={handleCycleAudioTrack}
              className="px-2 py-1 rounded bg-zinc-900 border border-white/10 hover:bg-zinc-800 text-zinc-200 font-mono text-[11px] flex items-center gap-1 cursor-pointer"
              title={`Audio Track: ${audioTracks[audioTrackIdx]?.title || 'Default'} (click to switch)`}
            >
              <AudioTrackIcon className="w-3 h-3 text-emerald-400" />
              <span className="max-w-[90px] truncate">{audioTracks[audioTrackIdx]?.language?.toUpperCase() || `A${audioTrackIdx + 1}`}</span>
            </button>
          )}

          <button
            onClick={subtitleTracks.length > 1 ? handleCycleSubtitleTrack : handleToggleSubtitles}
            className={`px-2.5 py-1 rounded text-[11px] font-mono font-bold transition-colors cursor-pointer flex items-center gap-1.5 ${
              subtitlesEnabled
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-zinc-900 border border-white/10 text-zinc-400 hover:text-white'
            }`}
            title={subtitleTracks.length > 1 ? 'Cycle Subtitle Track (C to toggle)' : 'Toggle Subtitles (C)'}
          >
            <Subtitles className="w-3.5 h-3.5" />
            <span>
              {subtitleTracks.length > 1
                ? `CC:${subtitleTracks[subTrackIdx]?.language?.toUpperCase() || subTrackIdx + 1}`
                : 'CC'}
            </span>
          </button>

          <button
            onClick={toggleFitMode}
            aria-label={`Video fit mode: ${fitMode === 'contain' ? 'Fit Window' : 'Fill Screen'}`}
            className={`px-2.5 py-1 rounded text-[11px] font-mono font-bold transition-colors cursor-pointer flex items-center gap-1 ${
              fitMode === 'cover'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-zinc-900 border border-white/10 text-zinc-400 hover:text-white'
            }`}
            title="Toggle Fill Screen / Fit (Z)"
          >
            <span>{fitMode === 'cover' ? 'Fill' : 'Fit'}</span>
          </button>

          {typeof document !== 'undefined' && document.pictureInPictureEnabled && (
            <button
              onClick={togglePip}
              aria-label="Picture-in-Picture"
              className="w-8 h-8 rounded-lg bg-zinc-900 border border-white/10 hover:bg-zinc-800 text-zinc-300 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
              title="Picture-in-Picture"
            >
              <PictureInPicture2 className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            onClick={toggleFullscreen}
            aria-label="Toggle Fullscreen (F)"
            className="w-8 h-8 rounded-lg bg-zinc-900 border border-white/10 hover:bg-zinc-800 text-zinc-300 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
            title="Fullscreen (F)"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>

          <a
            href={downloadHref}
            download={video.filename}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-white/10 hover:bg-zinc-800 text-zinc-300 hover:text-white transition-colors cursor-pointer text-xs"
            title="Download file directly"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Download</span>
          </a>

          <button
            onClick={handleTriggerFdm}
            disabled={isTriggeringFdm}
            aria-label="Download with Free Download Manager (FDM)"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer text-xs font-semibold disabled:opacity-50"
            title="Download with Free Download Manager (FDM)"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>FDM</span>
          </button>
        </div>
      </div>

      {/* Stream Health & Meta Footer */}
      <div className="px-4 py-2 bg-zinc-950/90 border-t border-white/10 flex items-center justify-between text-[11px] font-mono text-zinc-400">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isBuffering ? 'bg-amber-400' : 'bg-emerald-400'} animate-pulse`} />
          <span className="text-zinc-300 font-semibold">
            {useTransmux ? 'Live Transmux • H.264/AAC' : 'Direct MTProto Range Stream'}
          </span>
          <span className="text-zinc-600">•</span>
          <span className="text-emerald-400">
            Buffer Ahead: {bufferSecondsAhead}s ({bufferedPercent}%)
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-zinc-300">{formatBytes(video.size || video.file_size || 0)}</span>
          {video.resolution && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-zinc-800 text-zinc-200">
              {video.resolution}
            </span>
          )}
        </div>
      </div>
    </DialogContent>
  );
};

export const VideoPlayerModal: React.FC<VideoPlayerModalProps> = ({
  video,
  open,
  onOpenChange,
  onNext,
  onPrevious,
  hasNext = false,
  hasPrevious = false,
}) => {
  const triggerElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      triggerElementRef.current = (document.activeElement as HTMLElement) || null;
    } else if (triggerElementRef.current && typeof triggerElementRef.current.focus === 'function') {
      const el = triggerElementRef.current;
      setTimeout(() => {
        el?.focus();
      }, 50);
    }
  }, [open]);

  if (!video) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <VideoPlayerSession
          key={`${video.chat_id}_${video.message_id}`}
          video={video}
          onOpenChange={onOpenChange}
          onNext={onNext}
          onPrevious={onPrevious}
          hasNext={hasNext}
          hasPrevious={hasPrevious}
        />
      )}
    </Dialog>
  );
};
