// React component over rioterm. Rendering, input, selection, and
// clipboard all come from rioterm's open(); the `renderer` prop picks
// between the canvas painter (default) and the DOM-rows painter, both
// living in the core library.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from 'react';
import {
  Terminal,
  defaultTheme,
  initWasm,
  open,
  type RioTermHandle as CoreHandle,
  type TerminalOptions,
  type Theme,
} from 'rioterm';

export interface RioTerminalProps {
  options?: TerminalOptions;
  /** How to paint the grid: 'canvas' (default) or 'dom'. */
  renderer?: 'canvas' | 'dom';
  theme?: Theme;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  cursorStyle?: 'block' | 'bar' | 'underline';
  autoFocus?: boolean;
  /** Track the container size and refit the grid (default true). */
  fit?: boolean;
  /** OSC 8 hyperlink activation; defaults to confirm() + window.open. */
  linkHandler?: { activate: (uri: string) => void };
  className?: string;
  style?: CSSProperties;
  /** Bytes for the backend (keystrokes, mouse reports, DA responses). */
  onData?: (data: Uint8Array) => void;
  onTitleChange?: (title: string, subtitle: string | null) => void;
  onBell?: () => void;
  onReady?: (terminal: Terminal) => void;
}

export interface RioTerminalHandle {
  /** Display backend/child output. */
  write(data: string | Uint8Array): void;
  /** Send text to the backend as user input. */
  input(text: string): void;
  paste(text: string): void;
  focus(): void;
  resize(cols: number, rows: number): void;
  getSelection(): string | undefined;
  terminal(): Terminal | null;
}

export const RioTerminal = forwardRef<RioTerminalHandle, RioTerminalProps>(
  function RioTerminal(props, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const handleRef = useRef<CoreHandle | null>(null);

    // Latest-callback refs so the subscriptions never go stale.
    const onDataRef = useRef(props.onData);
    onDataRef.current = props.onData;
    const onTitleRef = useRef(props.onTitleChange);
    onTitleRef.current = props.onTitleChange;
    const onBellRef = useRef(props.onBell);
    onBellRef.current = props.onBell;
    const onReadyRef = useRef(props.onReady);
    onReadyRef.current = props.onReady;

    useEffect(() => {
      let disposed = false;
      let handle: CoreHandle | undefined;

      void open(hostRef.current!, {
        ...props.options,
        renderer: props.renderer,
        theme: props.theme ?? defaultTheme,
        ...(props.fontFamily !== undefined && { fontFamily: props.fontFamily }),
        ...(props.fontSize !== undefined && { fontSize: props.fontSize }),
        ...(props.lineHeight !== undefined && { lineHeight: props.lineHeight }),
        ...(props.cursorStyle !== undefined && { cursorStyle: props.cursorStyle }),
        ...(props.linkHandler !== undefined && { linkHandler: props.linkHandler }),
        autoFocus: props.autoFocus !== false,
        fit: props.fit,
      }).then((h) => {
        if (disposed) {
          h.dispose();
          return;
        }
        handle = h;
        handleRef.current = h;
        h.terminal.onData((bytes) => onDataRef.current?.(bytes));
        h.terminal.onTitleChange((t, s) => onTitleRef.current?.(t, s));
        h.terminal.onBell(() => onBellRef.current?.());
        onReadyRef.current?.(h.terminal);
      });

      return () => {
        disposed = true;
        handleRef.current = null;
        handle?.dispose();
      };
      // Mounted once; changing options/renderer/theme needs a remount (key=).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(
      ref,
      (): RioTerminalHandle => ({
        write: (data) => handleRef.current?.terminal.write(data),
        input: (text) => handleRef.current?.terminal.input(text),
        paste: (text) => handleRef.current?.terminal.paste(text),
        focus: () => handleRef.current?.focus(),
        resize: (cols, rows) => handleRef.current?.terminal.resize(cols, rows),
        getSelection: () => handleRef.current?.terminal.getSelection(),
        terminal: () => handleRef.current?.terminal ?? null,
      }),
      [],
    );

    return (
      <div
        ref={hostRef}
        className={props.className}
        style={{ width: '100%', height: '100%', overflow: 'hidden', ...props.style }}
      />
    );
  },
);

export { Terminal, initWasm, defaultTheme };
export type { Theme, TerminalOptions };
