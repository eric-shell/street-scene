/**
 * Lucide icons (https://lucide.dev) for the whole game: DOM SVGs for menus,
 * HUD and buttons, and canvas rendering so the same icons can become 3D
 * textures (e.g. the route arrows on barriers).
 */
import { createElement, type IconNode } from 'lucide';

export {
  ArrowBigRight,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Car,
  CarFront,
  Check,
  Copy,
  Flag,
  FlagTriangleRight,
  Gauge,
  Heart,
  Info,
  Layers,
  Monitor,
  Paintbrush,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings,
  Share2,
  Sparkles,
  Timer,
  Trash2,
  Trophy,
  Upload,
  Video,
  Wrench,
  X,
  Zap,
  Disc3,
  Route,
  Ghost,
  Wind,
  Palette,
  SlidersHorizontal,
  CircleDot,
  Shirt,
  Sun,
  Eye,
  EyeOff,
  Camera,
  Keyboard,
  Gamepad2,
  Smartphone,
  Download,
  ArrowUpDown,
  Shuffle,
  FlipHorizontal2,
  Hash,
  Award,
  Medal,
  Clock,
  Navigation,
  TriangleAlert,
  Move,
  Box,
  Hammer,
  ListOrdered,
  Calendar,
  ListMusic,
  Minimize2,
  Music,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Drone,
  Compass,
  Mountain,
  ArrowUp,
  ArrowDown,
  MousePointerClick,
  Undo2,
  Users,
  Code,
  Pencil,
  Warehouse,
  // The menu's city features and maps.
  Map as MapIcon,
  Waves,
  Anchor,
  TrainFront,
  Store,
  Landmark,
  MountainSnow,
  Trees,
  SquareParking,
  // The full city map: zoom and find-me controls, the waypoint.
  LocateFixed,
  ZoomIn,
  ZoomOut,
  Maximize2,
  MapPin,
  MapPinned,
  MapPinOff,
  Navigation2,
} from 'lucide';
export type { IconNode };

export interface IconOptions {
  size?: number;
  strokeWidth?: number;
  className?: string;
  label?: string;
}

/** A Lucide icon as an inline SVG element. Inherits text color. */
export function icon(node: IconNode, opts: IconOptions = {}): SVGElement {
  const el = createElement(node) as SVGElement;
  const size = opts.size ?? 18;
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('stroke-width', String(opts.strokeWidth ?? 2));
  el.classList.add('icon');
  if (opts.className) el.classList.add(...opts.className.split(' '));
  if (opts.label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', opts.label);
  } else el.setAttribute('aria-hidden', 'true');
  return el;
}

/** Element with an icon followed by text, e.g. for buttons and tabs. */
export function iconLabel(node: IconNode, text: string, size = 18): DocumentFragment {
  const f = document.createDocumentFragment();
  f.appendChild(icon(node, { size }));
  const span = document.createElement('span');
  span.textContent = text;
  f.appendChild(span);
  return f;
}

/**
 * Draw a Lucide icon onto a 2D canvas. Lucide icons are 24x24 stroke
 * drawings made of path, line, polyline, polygon, circle, ellipse and rect.
 */
export function drawIcon(ctx: CanvasRenderingContext2D, node: IconNode, x: number, y: number, size: number, color: string, strokeWidth = 2): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [tag, attrs] of node) {
    const a = attrs as Record<string, string | number>;
    const n = (k: string) => Number(a[k] ?? 0);
    let path: Path2D | null = null;
    switch (tag) {
      case 'path':
        path = new Path2D(String(a.d));
        break;
      case 'line':
        path = new Path2D(`M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`);
        break;
      case 'polyline':
      case 'polygon': {
        const pts = String(a.points).trim().split(/[\s,]+/).map(Number);
        let d = '';
        for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i]} ${pts[i + 1]}`;
        if (tag === 'polygon') d += 'Z';
        path = new Path2D(d);
        break;
      }
      case 'circle':
        path = new Path2D();
        path.arc(n('cx'), n('cy'), n('r'), 0, Math.PI * 2);
        break;
      case 'ellipse':
        path = new Path2D();
        path.ellipse(n('cx'), n('cy'), n('rx'), n('ry'), 0, 0, Math.PI * 2);
        break;
      case 'rect': {
        path = new Path2D();
        const rx = n('rx');
        if (rx > 0 && 'roundRect' in path) path.roundRect(n('x'), n('y'), n('width'), n('height'), rx);
        else path.rect(n('x'), n('y'), n('width'), n('height'));
        break;
      }
    }
    if (path) ctx.stroke(path);
  }
  ctx.restore();
}
