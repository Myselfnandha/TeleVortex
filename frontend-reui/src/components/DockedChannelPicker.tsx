import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatItem, CinemaVideo } from '@/types';
import { api } from '@/services/api';
import { socketService } from '@/services/socket';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { DockedTelegramChat } from '@/components/DockedTelegramChat';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Bookmark,
  Bot,
  Check,
  ChevronRight,
  Hash,
  MessageSquare,
  PanelLeftClose,
  Pin,
  RefreshCw,
  Search,
  Send,
  User,
  Users,
} from 'lucide-react';

interface DockedChannelPickerProps {
  selectedChat?: ChatItem;
  selectedChatId?: string | number;
  onSelect: (chat: ChatItem) => void;
  onClose?: () => void;
  onPlayVideo?: (video: CinemaVideo, forceBrowser?: boolean) => void;
  onPlayVlc?: (video: CinemaVideo) => void;
}

const DOCK_WIDTH_STORAGE_KEY = 'cinema_channel_dock_width';
const MIN_DOCK_WIDTH = 240;
const MAX_DOCK_WIDTH = 520;
const EXPANDED_DOCK_WIDTH = 440;

const readStoredDockWidth = (): number | null => {
  try {
    const raw = localStorage.getItem(DOCK_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= MIN_DOCK_WIDTH && parsed <= MAX_DOCK_WIDTH) {
      return parsed;
    }
  } catch {}
  return null;
};

export const DockedChannelPicker: React.FC<DockedChannelPickerProps> = ({
  selectedChat,
  selectedChatId,
  onSelect,
  onClose,
  onPlayVideo,
  onPlayVlc,
}) => {
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'channel' | 'user' | 'group' | 'bot' | 'saved' | 'contact'>('all');
  const [activeConversation, setActiveConversation] = useState<ChatItem | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [customWidth, setCustomWidth] = useState<number | null>(readStoredDockWidth);
  const [isResizing, setIsResizing] = useState(false);

  const asideRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isMobileOverlay = !isDesktop && Boolean(onClose);

  useEffect(() => {
    // Only engage focus trapping/restoration when rendered as mobile/tablet overlay (< 1024px)
    if (!isMobileOverlay) return;

    triggerElementRef.current = (document.activeElement && document.activeElement !== document.body)
      ? (document.activeElement as HTMLElement)
      : document.querySelector<HTMLElement>('button[aria-label="Open Channels & Chats Sidebar"]');

    // Focus initial element inside drawer
    const timer = setTimeout(() => {
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      } else if (asideRef.current) {
        const firstFocusable = asideRef.current.querySelector<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        firstFocusable?.focus();
      }
    }, 50);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
        return;
      }

      if (e.key === 'Tab' && asideRef.current) {
        const focusable = Array.from(asideRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (!asideRef.current.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
          return;
        }

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
      setTimeout(() => {
        const btn = (triggerElementRef.current && triggerElementRef.current.isConnected)
          ? triggerElementRef.current
          : document.querySelector<HTMLElement>('button[aria-label="Open Channels & Chats Sidebar"]');
        btn?.focus();
      }, 80);
    };
  }, [isMobileOverlay, onClose]);

  const loadChats = async (forceRefresh = false) => {
    setLoading(true);
    try {
      const data = await api.getChats(forceRefresh);
      setChats(data);
    } catch (e) {
      console.debug('Failed to fetch chats:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadChats(false);

    const unsubDialogs = socketService.onDialogUpdate((data) => {
      if (data && Array.isArray(data.dialogs) && data.dialogs.length > 0) {
        setChats(data.dialogs);
      } else {
        loadChats(true);
      }
    });

    return () => {
      unsubDialogs();
    };
  }, []);

  const persistWidth = useCallback((width: number | null) => {
    setCustomWidth(width);
    try {
      if (width === null) {
        localStorage.removeItem(DOCK_WIDTH_STORAGE_KEY);
      } else {
        localStorage.setItem(DOCK_WIDTH_STORAGE_KEY, String(width));
      }
    } catch {}
  }, []);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDesktop || !asideRef.current) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = asideRef.current.getBoundingClientRect().width;
    setIsResizing(true);

    const maxAllowedForViewport = Math.max(
      MIN_DOCK_WIDTH,
      Math.min(MAX_DOCK_WIDTH, window.innerWidth - 540)
    );

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = Math.round(
        Math.max(MIN_DOCK_WIDTH, Math.min(maxAllowedForViewport, startWidth + delta))
      );
      setCustomWidth(nextWidth);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      setIsResizing(false);

      const delta = upEvent.clientX - startX;
      const finalWidth = Math.round(
        Math.max(MIN_DOCK_WIDTH, Math.min(maxAllowedForViewport, startWidth + delta))
      );
      persistWidth(finalWidth);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  };

  const handleResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isDesktop || !asideRef.current) return;
    const current = customWidth ?? Math.round(asideRef.current.getBoundingClientRect().width);
    const maxAllowed = Math.max(MIN_DOCK_WIDTH, Math.min(MAX_DOCK_WIDTH, window.innerWidth - 540));
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      persistWidth(Math.min(maxAllowed, current + 20));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      persistWidth(Math.max(MIN_DOCK_WIDTH, current - 20));
    } else if (e.key === 'Home') {
      e.preventDefault();
      persistWidth(null);
      setIsExpanded(false);
    }
  };

  const filteredChats = chats.filter((c) => {
    const matchesSearch =
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.username && c.username.toLowerCase().includes(search.toLowerCase()));

    if (!matchesSearch) return false;

    if (filter === 'all') {
      if (search.trim()) return true;
      return c.type !== 'contact' && !c.is_contact;
    }
    if (filter === 'saved') return c.type === 'saved_messages';
    if (filter === 'channel') return c.type === 'channel' || c.type === 'supergroup';
    if (filter === 'user') return c.type === 'user';
    if (filter === 'group') return c.type === 'group' || c.type === 'supergroup';
    if (filter === 'bot') return c.type === 'bot';
    if (filter === 'contact') return c.type === 'contact' || Boolean(c.is_contact);

    return true;
  });

  const handleOpenChat = (chat: ChatItem) => {
    onSelect(chat);
    setActiveConversation(chat);
  };

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
      case 'contact':
        return <User className="w-3.5 h-3.5 text-blue-400" />;
      default:
        return <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />;
    }
  };

  const desktopWidthClasses =
    isExpanded && activeConversation
      ? 'static z-auto w-[440px] min-w-[340px] max-w-[520px] p-0 bg-transparent shadow-none'
      : 'static z-auto w-[26%] min-w-[240px] max-w-[360px] p-0 bg-transparent shadow-none';

  const desktopInlineStyle: React.CSSProperties | undefined =
    isDesktop && customWidth !== null && !(isExpanded && activeConversation)
      ? { width: `${customWidth}px`, minWidth: `${MIN_DOCK_WIDTH}px`, maxWidth: `${MAX_DOCK_WIDTH}px` }
      : undefined;

  return (
    <>
      {/* Mobile/Tablet Backdrop */}
      {onClose && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-xs z-40 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        id="telegram-chat-dock"
        ref={asideRef}
        role={isMobileOverlay ? 'dialog' : undefined}
        aria-modal={isMobileOverlay ? 'true' : undefined}
        aria-label="Channels & Chats Drawer"
        style={desktopInlineStyle}
        className={`${
          isDesktop
            ? desktopWidthClasses
            : 'fixed inset-y-0 left-0 z-50 w-[88vw] max-w-[380px] p-2 bg-background/95 backdrop-blur-xl shadow-2xl'
        } shrink-0 h-full flex flex-col min-h-0 transition-none animate-in slide-in-from-left-3 duration-200 ${
          isResizing ? 'select-none' : ''
        }`}
      >
        <div className="relative h-full flex flex-col min-h-0 p-2 rounded-xl border border-border/70 bg-card/85 backdrop-blur-xl shadow-xs space-y-1.5">
          {activeConversation ? (
            <DockedTelegramChat
              key={String(activeConversation.id)}
              chat={activeConversation}
              onBackToChats={() => setActiveConversation(null)}
              onClose={onClose}
              onPlayVideo={onPlayVideo}
              onPlayVlc={onPlayVlc}
              isExpanded={isExpanded}
              onToggleExpand={() => {
                setIsExpanded((v) => !v);
                if (!isExpanded && customWidth !== null && customWidth < EXPANDED_DOCK_WIDTH) {
                  persistWidth(null);
                }
              }}
              showExpandControl={isDesktop}
            />
          ) : (
            <>
              {/* Unified Telegram Chats Header */}
              <div className="flex items-center justify-between pb-1.5 border-b border-border/50 shrink-0 px-0.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Send className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <h3 className="text-xs font-semibold text-foreground truncate">Telegram Chats</h3>
                  <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-primary/30 text-primary bg-primary/10 font-mono shrink-0">
                    {filteredChats.length}
                  </Badge>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => loadChats(true)}
                    disabled={loading}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
                    title="Refresh dialogs"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                  </Button>
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

              <div className="relative shrink-0">
                <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  placeholder="Search chats & channels..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-7 h-7 text-xs bg-background/60"
                />
              </div>

              <div className="flex items-center gap-1 overflow-x-auto pb-0.5 scrollbar-none shrink-0">
                {(
                  [
                    { id: 'all', label: 'All' },
                    { id: 'channel', label: 'Channels' },
                    { id: 'user', label: 'Chats' },
                    { id: 'group', label: 'Groups' },
                    { id: 'bot', label: 'Bots' },
                    { id: 'saved', label: 'Saved' },
                    { id: 'contact', label: 'Contacts' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setFilter(tab.id)}
                    className={`text-xs px-3 py-1.5 min-h-[36px] rounded-full whitespace-nowrap transition-colors cursor-pointer flex items-center justify-center ${
                      filter === tab.id
                        ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                        : 'bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted font-medium'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto space-y-1 pr-1 scrollbar-thin">
                {loading && chats.length === 0 ? (
                  <div className="p-8 text-center text-xs text-muted-foreground">
                    <RefreshCw className="w-4 h-4 mx-auto mb-2 animate-spin text-primary" />
                    Loading channels...
                  </div>
                ) : filteredChats.length === 0 ? (
                  <div className="p-6 text-center text-xs text-muted-foreground">
                    No matching channels found.
                  </div>
                ) : (
                  filteredChats.map((chat) => {
                    const currentId = selectedChat?.id ?? selectedChatId;
                    const isSelected =
                      String(chat.id) === String(currentId) ||
                      ((currentId === 'me' || currentId === 'self') && chat.type === 'saved_messages') ||
                      String(chat.id).replace(/^-100/, '').replace(/^-/, '') === String(currentId).replace(/^-100/, '').replace(/^-/, '');
                    return (
                      <button
                        key={chat.id}
                        type="button"
                        onClick={() => handleOpenChat(chat)}
                        className={`group w-full text-left p-1.5 rounded-lg flex items-center justify-between gap-2 transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-primary/15 text-foreground border-l-2 border-primary shadow-2xs'
                            : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
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
                            <div className="text-xs font-medium truncate flex items-center gap-1">
                              <span className={isSelected ? 'text-primary font-semibold' : 'text-foreground'}>
                                {chat.name}
                              </span>
                              {chat.pinned && <Pin className="w-2.5 h-2.5 text-muted-foreground rotate-45 shrink-0" />}
                              {chat.type === 'bot' && (
                                <Badge variant="outline" className="text-[10px] px-1 py-0 h-3.5 border-cyan-500/40 text-cyan-400 bg-cyan-500/10 font-semibold tracking-wide">
                                  BOT
                                </Badge>
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {chat.username ? `@${chat.username}` : chat.type === 'user' ? 'Direct Chat' : chat.type === 'contact' ? 'Contact' : chat.type.replace('_', ' ')}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          {chat.unread_count && chat.unread_count > 0 ? (
                            <Badge variant="secondary" className="text-[9px] h-4 px-1">
                              {chat.unread_count}
                            </Badge>
                          ) : null}
                          {isSelected && <Check className="w-3.5 h-3.5 text-primary" />}
                          <ChevronRight className="w-3 h-3 text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}

          {/* Desktop Drag-to-Resize Handle */}
          {isDesktop && (
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize Telegram chat dock"
              aria-valuemin={MIN_DOCK_WIDTH}
              aria-valuemax={MAX_DOCK_WIDTH}
              aria-valuenow={customWidth ?? undefined}
              onPointerDown={handleResizePointerDown}
              onDoubleClick={() => {
                setIsExpanded(false);
                persistWidth(null);
              }}
              onKeyDown={handleResizeKeyDown}
              title="Drag to resize chat dock (double-click to reset)"
              className="hidden lg:flex items-center justify-center absolute top-2 bottom-2 -right-2 w-2.5 cursor-col-resize group z-20 focus:outline-none"
            >
              <div
                className={`w-0.5 h-10 rounded-full transition-all ${
                  isResizing
                    ? 'bg-sky-400 h-16 shadow-[0_0_8px_rgba(56,189,248,0.6)]'
                    : 'bg-border/60 group-hover:bg-sky-400/80 group-hover:h-14 group-focus-visible:bg-sky-400'
                }`}
              />
            </div>
          )}
        </div>
      </aside>
    </>
  );
};
