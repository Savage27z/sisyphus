import type { Arena, MapId } from '../arena';
import { Building, CONSTRUCTION, HOTEL, TOWER } from '../building';
import type { Game } from '../game';
import { Olympus } from './olympus';

export interface MapInfo {
  id: MapId;
  name: string;
  blurb: string;
  /** Accent for map cards. */
  color: string;
}

/** Every map, in rotation order (the server rotates public rounds through them the same way). */
export const MAPS: MapInfo[] = [
  { id: 'olympus', name: 'Mount Olympus', blurb: 'A spiral road up a mountain: rockfalls, bronze axes and lightning, cliffs on every side.', color: '#8be86a' },
  { id: 'tower', name: 'The Tower', blurb: 'Twelve floors of offices, labs and libraries around a glass atrium.', color: '#7fd4ff' },
  { id: 'construction', name: 'Construction Site', blurb: 'An unfinished skyscraper: no walls, wind gusts and a swinging crane.', color: '#ffb23f' },
  { id: 'hotel', name: 'Haunted Hotel', blurb: 'Ghosts, chandeliers and trapdoors in a grand hotel at midnight.', color: '#c39bff' },
];

export const mapInfo = (id: MapId): MapInfo => MAPS.find((m) => m.id === id) ?? MAPS[1];
export const mapName = (id: MapId) => mapInfo(id).name;
export const nextMap = (id: MapId): MapId => MAPS[(MAPS.findIndex((m) => m.id === id) + 1) % MAPS.length].id;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Map cards (practice picker, a friends room's map choice). Without `onPick` they're read-only. */
export function renderMapCards(el: HTMLElement, selected: MapId | null, onPick: ((id: MapId) => void) | null): void {
  el.innerHTML = MAPS.map(
    (m) =>
      `<button class="mapCard${m.id === selected ? ' selected' : ''}" data-map="${m.id}" style="--map:${m.color}"${onPick ? '' : ' disabled'}>` +
      `<b>${esc(m.name)}</b><span>${esc(m.blurb)}</span></button>`,
  ).join('');
  if (!onPick) return;
  el.querySelectorAll<HTMLButtonElement>('.mapCard').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.map as MapId)));
}

export function createMap(id: MapId, game: Game): Arena {
  switch (id) {
    case 'olympus':
      return new Olympus(game);
    case 'construction':
      return new Building(game, CONSTRUCTION);
    case 'hotel':
      return new Building(game, HOTEL);
    default:
      return new Building(game, TOWER);
  }
}
