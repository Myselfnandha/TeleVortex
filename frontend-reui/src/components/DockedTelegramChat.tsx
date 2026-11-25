import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatItem, ChatMessage, CinemaVideo } from '@/types';
import { api } from '@/services/api';
import { socketService } from '@/services/socket';
import { useApp } from '@/context/AppContext';
import { cleanFileName, formatBytes, formatDuration } from '@/lib/formatters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ArrowDown,
  Bookmark,
  Bot,
  Check,
  CheckCheck,
  ChevronLeft,
  Copy,
  Download,
  Eye,
  FileArchive,
  FileText,
  Hash,
  Maximize2,
  MessageSquare,
  Minimize2,
  Music,
  PanelLeftClose,
  Play,
  RefreshCw,
  Search,
  Send,
  Tv,
  User,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

interface DockedTelegramChatProps {
  chat: ChatItem;
  onBackToChats: () => void;
  onClose?: () => void;
  onPlayVideo?: (video: CinemaVideo, forceBrowser?: boolean) => void;
  onPlayVlc?: (video: CinemaVideo) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  showExpandControl?: boolean;
}

interface LightboxPhoto {
  src: string;
  title: string;
  downloadUrl?: string;
}

const normalizeId = (id: string | number | undefined | null): string => {
  if (id === undefined || id === null) return '';
  return String(id).trim().replace(/^-100/, '').replace(/^-/, '');
};

const getDateDivider = (isoDate?: string | null): string => {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
};

const formatMsgTime = (isoDate?: string | null): string => {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const getDocIcon = (filename?: string) => {
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'iso'].includes(ext)) {
    return <FileArchive className="w-4 h-4 text-amber-400 shrink-0" />;
  }
  if (['mp3', 'flac', 'wav', 'ogg', 'm4a', 'opus'].includes(ext)) {
    return <Music className="w-4 h-4 text-rose-400 shrink-0" />;
  }
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts'].includes(ext)) {
    return <Play className="w-4 h-4 text-sky-400 shrink-0" />;
  }
  return <FileText className="w-4 h-4 text-emerald-400 shrink-0" />;
};

const renderTextWithLinks = (text: string) => {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, idx) => {
    if (/^https?:\/\/[^\s]+$/.test(part)) {
      return (
        <a
          key={idx}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-400 hover:underline break-all"
          onClick={(e) => e.stopPropagation()}
        >
          {part}
        </a>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
};

export const DockedTelegramChat: React.FC<DockedTelegramChatProps> = ({
  chat,
  onBackToChats,
  onClose,
  onPlayVideo,
  onPlayVlc,
  isExpanded = false,
  onToggleExpand,
  showExpandControl = true,
}) => {
  const { addToast } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [isSearchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [lightboxPhoto, setLightboxPhoto] = useState<LightboxPhoto | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const activeChatIdRef = useRef<string | number>(chat.id);

  const PAGE_SIZE = 40;

  const loadMessages = useCallback(
    async (chatId: string | number, silent = false) => {
      if (!silent) {
        setLoading(true);
        setErrorMsg(null);
      }
      try {
        const res = await api.getChatMessages(chatId, PAGE_SIZE, 0);
        if (String(activeChatIdRef.current) !== String(chatId)) return;
        const chronological = [...(res.messages || [])].reverse();
        setMessages(chronological);
        setHasMore((res.messages || []).length >= PAGE_SIZE);
        if (!silent) {
          setTimeout(() => {
            bottomRef.current?.scrollIntoView({ behavior: 'auto' });
            setShowScrollBottom(false);
          }, 60);
        }
      } catch (err: any) {
        if (String(activeChatIdRef.current) !== String(chatId)) return;
        const detail = err?.message || 'Unable to load Telegram messages.';
        if (!silent) {
          setErrorMsg(detail);
        }
      } finally {
        if (!silent && String(activeChatIdRef.current) === String(chatId)) {
          setLoading(false);
        }
      }
    },
    []
  );

  const loadOlderMessages = async () => {
    if (loadingOlder || messages.length === 0) return;
    const oldestId = messages[0].id;
    const prevScrollHeight = containerRef.current?.scrollHeight || 0;
    setLoadingOlder(true);
    try {
      const res = await api.getChatMessages(chat.id, PAGE_SIZE, oldestId);
      const olderChronological = [...(res.messages || [])].reverse();
      if (olderChronological.length === 0) {
        setHasMore(false);
        return;
      }
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const uniqueOlder = olderChronological.filter((m) => !seen.has(m.id));
        return [...uniqueOlder, ...prev];
      });
      setHasMore(olderChronological.length >= PAGE_SIZE);
      requestAnimationFrame(() => {
        if (containerRef.current) {
          const newScrollHeight = containerRef.current.scrollHeight;
          containerRef.current.scrollTop += newScrollHeight - prevScrollHeight;
        }
      });
    } catch (err: any) {
      addToast({
        type: 'error',
        title: 'History Load Failed',
        message: err?.message || 'Could not load older messages.',
      });
    } finally {
      setLoadingOlder(false);
    }
  };

  useEffect(() => {
    activeChatIdRef.current = chat.id;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const res = await api.getChatMessages(chat.id, PAGE_SIZE, 0);
        if (cancelled) return;
        const chronological = [...(res.messages || [])].reverse();
        setMessages(chronological);
        setHasMore((res.messages || []).length >= PAGE_SIZE);
        setTimeout(() => {
          if (!cancelled) {
            bottomRef.current?.scrollIntoView({ behavior: 'auto' });
            setShowScrollBottom(false);
          }
        }, 60);
      } catch (err: any) {
        if (!cancelled) {
          setErrorMsg(err?.message || 'Unable to load Telegram messages.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chat.id]);

  useEffect(() => {
    const unsub = socketService.onDialogUpdate((data) => {
      if (!data || !data.chat_id) return;
      const incoming = String(data.chat_id).trim();
      const target = String(chat.id).trim();
      const matches =
        incoming === target ||
        (normalizeId(incoming) !== '' && normalizeId(incoming) === normalizeId(target)) ||
        (chat.type === 'saved_messages' && (incoming === 'me' || incoming === 'self'));

      if (matches) {
        void loadMessages(chat.id, true);
      }
    });
    return () => {
      unsub();
    };
  }, [chat.id, chat.type, loadMessages]);

  useEffect(() => {
    if (!lightboxPhoto) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLightboxPhoto(null);
        setZoomLevel(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxPhoto]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBottom(distanceFromBottom > 120);
  };

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowScrollBottom(false);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputText.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const res = await api.sendChatMessage(chat.id, trimmed);
      setInputText('');
      if (res.success) {
        const optimistic: ChatMessage = {
          id: res.message_id || Date.now(),
          date: new Date().toISOString(),
          text: trimmed,
          out: true,
          sender_name: 'You',
          media: null,
        };
        setMessages((prev) => {
          if (prev.some((m) => m.id === optimistic.id)) return prev;
          return [...prev, optimistic];
        });
        setTimeout(() => {
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 40);
        void loadMessages(chat.id, true);
      }
    } catch (err: any) {
      addToast({
        type: 'error',
        title: 'Send Failed',
        message: err?.message || 'Could not send message to this chat.',
      });
    } finally {
      setSending(false);
    }
  };

  const handleCopyText = (msg: ChatMessage) => {
    if (!msg.text) return;
    navigator.clipboard.writeText(msg.text).catch(() => {});
    setCopiedId(msg.id);
    setTimeout(() => setCopiedId((cur) => (cur === msg.id ? null : cur)), 1600);
  };

  const buildVideoFromMessage = (msg: ChatMessage): CinemaVideo => ({
    chat_id: chat.id,
    message_id: msg.id,
    filename: msg.media?.file_name || `video_${msg.id}.mp4`,
    size: msg.media?.file_size || 0,
    duration: msg.media?.duration || 0,
    thumb_url: msg.media?.thumb_url || `/stream/${encodeURIComponent(String(chat.id))}/${msg.id}/thumb`,
    date: msg.date || undefined,
  });

  const handlePlayMessageVideo = (msg: ChatMessage) => {
    const vid = buildVideoFromMessage(msg);
    if (onPlayVideo) {
      onPlayVideo(vid, true);
    } else if (msg.media?.stream_url) {
      window.open(msg.media.stream_url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleVlcMessageVideo = (msg: ChatMessage) => {
    const vid = buildVideoFromMessage(msg);
    if (onPlayVlc) {
      onPlayVlc(vid);
    } else if (msg.media?.stream_url) {
      window.location.href = `vlc://${window.location.origin}${msg.media.stream_url}`;
    }
  };

  const displayedMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    const q = searchQuery.trim().toLowerCase();
    return messages.filter((m) => {
      const textHit = m.text?.toLowerCase().includes(q);
      const senderHit = m.sender_name?.toLowerCase().includes(q);
      const fileHit = m.media?.file_name?.toLowerCase().includes(q);
      return Boolean(textHit || senderHit || fileHit);
    });
  }, [messages, searchQuery]);

  const getChatIcon = (type: ChatItem['type']) => {
    switch (type) {
      case 'saved_messages':
        return <Bookmark className="w-3.5 h-3.5 text-sky-400" />;
      case 'channel':
        return <Hash className="w-3.5 h-3.5 text-emerald-400" />;
      case 'supergroup':
      case 'group':
        return <Users className="w-3.5 h-3.5 text-violet-400" />;
      case 'bot':
        return <Bot className="w-3.5 h-3.5 text-cyan-400" />;
      case 'user':
        return <MessageSquare className="w-3.5 h-3.5 text-amber-400" />;
      default:
        return <User className="w-3.5 h-3.5 text-blue-400" />;
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-1.5">
      {/* Unified Telegram Conversation Header */}
      <div className="flex items-center justify-between gap-1 pb-1.5 border-b border-border/50 shrink-0 px-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={onBackToChats}
            className="h-7 px-1.5 rounded-md flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer shrink-0"
            title="Back to Telegram Chats"
            aria-label="Back to Telegram Chats"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>

          <div className="relative w-7 h-7 rounded-full bg-accent flex items-center justify-center shrink-0 overflow-hidden">
            {getChatIcon(chat.type)}
            {chat.photo_url && (
              <img
                src={chat.photo_url}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = 'none';
                }}
              />
            )}
          </div>

          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground truncate leading-tight" title={chat.name}>
              {chat.name}
            </div>
            <div className="text-[10px] text-muted-foreground truncate leading-tight">
              {chat.username ? `@${chat.username}` : chat.type.replace('_', ' ')}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSearchOpen((v) => !v)}
            className={`h-7 w-7 p-0 cursor-pointer ${isSearchOpen ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`}
            title="Search inside chat"
            aria-label="Search inside chat"
          >
            <Search className="w-3.5 h-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void loadMessages(chat.id, false)}
            disabled={loading}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
            title="Refresh messages"
            aria-label="Refresh messages"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          {showExpandControl && onToggleExpand && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onToggleExpand}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
              title={isExpanded ? 'Compact dock width' : 'Widen Telegram dock'}
              aria-label={isExpanded ? 'Compact dock width' : 'Widen Telegram dock'}
            >
              {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </Button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 min-w-[36px] min-h-[36px] sm:min-w-[28px] sm:min-h-[28px] flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
              title="Close Telegram Chat Dock (Ctrl+B)"
              aria-label="Close channels sidebar"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* In-Chat Search Input */}
      {isSearchOpen && (
        <div className="relative shrink-0">
          <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter messages or filenames..."
            className="pl-7 pr-6 h-7 text-xs bg-background/60"
            autoFocus
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
              aria-label="Clear message filter"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* Scrollable Message Thread */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1 py-1 scrollbar-thin"
        >
          {hasMore && !searchQuery && (
            <div className="flex justify-center pb-1">
              <button
                type="button"
                onClick={loadOlderMessages}
                disabled={loadingOlder}
                className="text-[10px] px-2.5 py-1 rounded-full bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
              >
                {loadingOlder ? 'Loading older...' : 'Load older messages'}
              </button>
            </div>
          )}

          {loading && messages.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              <RefreshCw className="w-4 h-4 mx-auto mb-2 animate-spin text-primary" />
              Loading Telegram chat...
            </div>
          ) : errorMsg ? (
            <div className="p-4 rounded-lg border border-destructive/30 bg-destructive/10 text-center space-y-2">
              <p className="text-[11px] text-destructive font-medium">{errorMsg}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadMessages(chat.id, false)}
                className="h-6 text-[10px] px-2 cursor-pointer"
              >
                Retry
              </Button>
            </div>
          ) : displayedMessages.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {searchQuery ? 'No messages match your filter.' : 'No recent messages in this chat.'}
            </div>
          ) : (
            displayedMessages.map((msg, idx) => {
              const prevMsg = idx > 0 ? displayedMessages[idx - 1] : null;
              const curDivider = getDateDivider(msg.date);
              const prevDivider = prevMsg ? getDateDivider(prevMsg.date) : '';
              const showDivider = Boolean(curDivider && curDivider !== prevDivider);

              const dlUrl = msg.media?.download_url
                ? msg.media.download_url
                : `/dl/${encodeURIComponent(String(chat.id))}/${msg.id}/${encodeURIComponent(msg.media?.file_name || `file_${msg.id}`)}`;

              return (
                <React.Fragment key={msg.id}>
                  {showDivider && (
                    <div className="flex justify-center my-1">
                      <span className="text-[9px] font-medium px-2 py-0.5 rounded-full bg-muted/70 text-muted-foreground border border-border/40">
                        {curDivider}
                      </span>
                    </div>
                  )}

                  <div className={`flex flex-col ${msg.out ? 'items-end' : 'items-start'}`}>
                    <div
                      className={`group relative max-w-[94%] rounded-xl px-2.5 py-1.5 border shadow-2xs space-y-1.5 ${
                        msg.out
                          ? 'bg-primary/15 border-primary/30 text-foreground rounded-br-xs'
                          : 'bg-background/75 border-border/60 text-foreground rounded-bl-xs'
                      }`}
                    >
                      {!msg.out && msg.sender_name && (
                        <div className="text-[10px] font-semibold text-primary truncate leading-tight">
                          {msg.sender_name}
                        </div>
                      )}

                      {/* Video Attachment */}
                      {msg.media?.type === 'video' && (
                        <div className="rounded-lg overflow-hidden border border-border/60 bg-zinc-950/90 space-y-1">
                          <div
                            className="relative aspect-video bg-zinc-950 cursor-pointer group/vid overflow-hidden"
                            onClick={() => handlePlayMessageVideo(msg)}
                            title="Play video in Cinema"
                          >
                            <img
                              src={msg.media.thumb_url || `/stream/${encodeURIComponent(String(chat.id))}/${msg.id}/thumb`}
                              alt=""
                              loading="lazy"
                              className="w-full h-full object-cover group-hover/vid:scale-105 transition-transform"
                              onError={(e) => {
                                (e.currentTarget as HTMLElement).style.display = 'none';
                              }}
                            />
                            <div className="absolute inset-0 bg-black/35 group-hover/vid:bg-black/50 flex items-center justify-center transition-colors">
                              <div className="w-8 h-8 rounded-full bg-primary/90 text-primary-foreground flex items-center justify-center shadow-lg">
                                <Play className="w-3.5 h-3.5 fill-current translate-x-0.5" />
                              </div>
                            </div>
                            {msg.media.duration ? (
                              <Badge className="absolute bottom-1 right-1 text-[9px] h-4 px-1 bg-black/75 text-white border-0 font-mono">
                                {formatDuration(msg.media.duration)}
                              </Badge>
                            ) : null}
                          </div>

                          <div className="px-2 py-1 space-y-1">
                            <div
                              className="text-[10px] font-medium text-zinc-100 truncate"
                              title={msg.media.file_name}
                            >
                              {cleanFileName(msg.media.file_name)}
                            </div>
                            <div className="flex items-center justify-between gap-1 text-[9px] text-zinc-400">
                              <span className="font-mono">{formatBytes(msg.media.file_size)}</span>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => handlePlayMessageVideo(msg)}
                                  className="px-1.5 py-0.5 rounded bg-primary/20 hover:bg-primary/35 text-primary font-semibold flex items-center gap-0.5 cursor-pointer"
                                  title="Play in Browser"
                                >
                                  <Play className="w-2.5 h-2.5 fill-current" />
                                  <span>Play</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleVlcMessageVideo(msg)}
                                  className="px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/35 text-amber-300 font-semibold flex items-center gap-0.5 cursor-pointer"
                                  title="Launch in VLC"
                                >
                                  <Tv className="w-2.5 h-2.5" />
                                  <span>VLC</span>
                                </button>
                                <a
                                  href={`/dl/${encodeURIComponent(String(chat.id))}/${msg.id}/${encodeURIComponent(msg.media.file_name || 'video.mp4')}`}
                                  download={msg.media.file_name || 'video.mp4'}
                                  className="p-0.5 rounded hover:bg-white/10 text-zinc-300"
                                  title="Download video"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <Download className="w-2.5 h-2.5" />
                                </a>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Photo Attachment */}
                      {msg.media?.type === 'photo' && (
                        <button
                          type="button"
                          onClick={() => {
                            setZoomLevel(1);
                            setLightboxPhoto({
                              src: msg.media?.thumb_url || `/stream/${encodeURIComponent(String(chat.id))}/${msg.id}/thumb`,
                              title: msg.media?.file_name || `Photo #${msg.id}`,
                              downloadUrl: dlUrl,
                            });
                          }}
                          className="block w-full rounded-lg overflow-hidden border border-border/50 bg-zinc-950 cursor-pointer hover:opacity-95 transition-opacity"
                        >
                          <img
                            src={msg.media.thumb_url || `/stream/${encodeURIComponent(String(chat.id))}/${msg.id}/thumb`}
                            alt={msg.media.file_name || 'Telegram photo'}
                            loading="lazy"
                            className="w-full max-h-44 object-cover"
                          />
                        </button>
                      )}

                      {/* Document Attachment */}
                      {msg.media?.type === 'document' && (
                        <div className="flex items-center justify-between gap-2 p-1.5 rounded-lg bg-muted/40 border border-border/50">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {getDocIcon(msg.media.file_name)}
                            <div className="min-w-0">
                              <div className="text-[10px] font-medium truncate" title={msg.media.file_name}>
                                {msg.media.file_name || `file_${msg.id}`}
                              </div>
                              <div className="text-[9px] text-muted-foreground font-mono">
                                {formatBytes(msg.media.file_size)}
                              </div>
                            </div>
                          </div>
                          <a
                            href={dlUrl}
                            download={msg.media.file_name || `file_${msg.id}`}
                            className="p-1 rounded-md bg-background/70 hover:bg-primary/15 text-muted-foreground hover:text-primary transition-colors shrink-0"
                            title="Download file"
                          >
                            <Download className="w-3 h-3" />
                          </a>
                        </div>
                      )}

                      {/* Message Text */}
                      {msg.text && (
                        <div className="text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                          {renderTextWithLinks(msg.text)}
                        </div>
                      )}

                      {/* Message Footer: Copy, Views, Timestamp, Outgoing Check */}
                      <div className="flex items-center justify-end gap-1.5 text-[9px] text-muted-foreground/80">
                        {msg.text && (
                          <button
                            type="button"
                            onClick={() => handleCopyText(msg)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-foreground cursor-pointer mr-auto"
                            title="Copy message"
                            aria-label="Copy message"
                          >
                            {copiedId === msg.id ? (
                              <Check className="w-2.5 h-2.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-2.5 h-2.5" />
                            )}
                          </button>
                        )}
                        {typeof msg.views === 'number' && msg.views > 0 && (
                          <span className="inline-flex items-center gap-0.5 font-mono">
                            <Eye className="w-2.5 h-2.5" />
                            {msg.views >= 1000 ? `${(msg.views / 1000).toFixed(1)}k` : msg.views}
                          </span>
                        )}
                        <span className="font-mono">{formatMsgTime(msg.date)}</span>
                        {msg.out && <CheckCheck className="w-2.5 h-2.5 text-sky-400" />}
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        {/* Scroll to bottom floating pill */}
        {showScrollBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-2 right-2 w-7 h-7 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:scale-105 transition-transform cursor-pointer z-10"
            title="Scroll to latest message"
            aria-label="Scroll to latest message"
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Send Message Composer */}
      <form onSubmit={handleSend} className="flex items-center gap-1 pt-1 border-t border-border/50 shrink-0">
        <Input
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Message in Telegram..."
          disabled={sending}
          className="h-7 text-xs bg-background/70 flex-1 min-w-0"
        />
        <Button
          type="submit"
          size="sm"
          disabled={sending || !inputText.trim()}
          className="h-7 w-7 p-0 shrink-0 cursor-pointer"
          title="Send Telegram message"
          aria-label="Send Telegram message"
        >
          <Send className="w-3 h-3" />
        </Button>
      </form>

      {/* Photo Lightbox Overlay */}
      {lightboxPhoto && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center p-4"
          onClick={() => {
            setLightboxPhoto(null);
            setZoomLevel(1);
          }}
        >
          <div
            className="flex items-center gap-2 mb-3 bg-card/90 border border-border/60 rounded-full px-3 py-1"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-xs font-medium text-foreground max-w-[180px] truncate">
              {lightboxPhoto.title}
            </span>
            <button
              type="button"
              onClick={() => setZoomLevel((z) => Math.max(0.5, z - 0.25))}
              className="p-1 text-muted-foreground hover:text-foreground cursor-pointer"
              title="Zoom out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setZoomLevel((z) => Math.min(3, z + 0.25))}
              className="p-1 text-muted-foreground hover:text-foreground cursor-pointer"
              title="Zoom in"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            {lightboxPhoto.downloadUrl && (
              <a
                href={lightboxPhoto.downloadUrl}
                download
                className="p-1 text-muted-foreground hover:text-primary"
                title="Download photo"
              >
                <Download className="w-3.5 h-3.5" />
              </a>
            )}
            <button
              type="button"
              onClick={() => {
                setLightboxPhoto(null);
                setZoomLevel(1);
              }}
              className="p-1 text-muted-foreground hover:text-destructive cursor-pointer"
              title="Close preview"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <img
            src={lightboxPhoto.src}
            alt={lightboxPhoto.title}
            onClick={(e) => e.stopPropagation()}
            style={{ transform: `scale(${zoomLevel})` }}
            className="max-w-[90vw] max-h-[80vh] rounded-xl shadow-2xl object-contain transition-transform"
          />
        </div>
      )}
    </div>
  );
};
