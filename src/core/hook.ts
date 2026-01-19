/// <reference types="tampermonkey" />
import { updateOverlays } from './overlay';
import { updateUI } from '../ui/panel';
import type { Map } from 'maplibre-gl';
import { findExport, findModule, moduleFilters } from './modules';
import { clearOverlayCache } from './cache';
import { createCanvas } from './canvas';

let hookInstalled = false;

const page: any = unsafeWindow;

type Menu = { name: 'mainMenu' } |
  { name: 'selectHq' } |
  { name: 'paintingPixel' } |
  { name: 'paintingPixel', clickedLatLon: [number, number] } |
  { name: 'pixelSelected', latLon: [number, number] };

function isMenu(x: any): x is Menu {
  const possibleNames = ['mainMenu', 'pixelSelected', 'paintingPixel', 'selectHq'];
  return x && x.name && possibleNames.includes(x.name);
}

export let map: Map | null = null;
export let user: any = null;
export let menu: Menu = { name: 'mainMenu' };
export let gm: any = null;

export function attachHook() {
  if (hookInstalled) return;
  hookInstalled = true;

  // Cache original constructors to avoid detection
  const OriginalObject = page.Object;
  const OriginalPromise = page.Promise;
  const OriginalProxy = page.Proxy;
  const OriginalMap = page.Map;
  const originalAssign = OriginalObject.assign;
  const originalMapSet = OriginalMap.prototype.set;

  // Track interception states
  let assignIntercepted = false;
  let promiseIntercepted = false;
  let gmDetected = false;

  // Hook 1: Object.assign - intercept fetch modifications
  // Bypass pawtect for data URIs that fetch images
  page.Object.assign = new Proxy(originalAssign, {
    apply(target: any, thisArg: any, args: any[]) {
      const [assignTarget, source] = args;
      
      if (!assignIntercepted && assignTarget === page && source && source.fetch) {
        assignIntercepted = true;
        
        const pageFetch = page.fetch;
        const sourceFetch = source.fetch;
        
        // Wrap the fetch being assigned
        source.fetch = new Proxy(sourceFetch, {
          apply(fetchTarget: any, fetchThisArg: any, fetchArgs: any[]) {
            const [urlOrRequest] = fetchArgs;
            const url = urlOrRequest instanceof Request ? urlOrRequest.url : urlOrRequest;
            
            // Use page's original fetch for data URIs (bypass pawtect)
            if (url && typeof url === 'string' && url.startsWith('data:image/png')) {
              return Reflect.apply(pageFetch, fetchThisArg, fetchArgs);
            }
            
            return Reflect.apply(fetchTarget, fetchThisArg, fetchArgs);
          }
        });
      }
      
      return Reflect.apply(target, thisArg, args);
    }
  });

  // Hook 2: Promise - detect map initialization
  page.Promise = new Proxy(OriginalPromise, {
    construct(target: any, args: any[]) {
      const [executor] = args;
      
      if (!promiseIntercepted && executor && typeof executor === 'function') {
        const executorSource = executor.toString();
        
        if (executorSource.includes('"waterway_tunnel"')) {
          promiseIntercepted = true;
          
          const promiseInstance = Reflect.construct(target, args);
          
          promiseInstance.then((resolvedValue: any) => {
            // Check if this is the map object
            if (resolvedValue && 
                typeof resolvedValue.on === 'function' && 
                typeof resolvedValue.getSource === 'function') {
              map = resolvedValue as Map;
              page._map = resolvedValue;
              
              // Handle map initialization asynchronously
              Promise.resolve().then(() => onMap()).catch((err: any) => {
                console.error('Overlay Pro: Map init error', err);
              });
            }
            return resolvedValue;
          }).catch(() => {});
          
          return promiseInstance;
        }
      }
      
      return Reflect.construct(target, args);
    }
  });

  // Hook 3: Proxy - detect menu state changes
  page.Proxy = new Proxy(OriginalProxy, {
    construct(target: any, args: any[]) {
      const [proxyTarget, handler] = args;
      const proxyInstance = Reflect.construct(target, args);
      
      if (isMenu(proxyTarget)) {
        menu = proxyInstance;
        page._menu = proxyInstance;
        
        // Update UI asynchronously
        Promise.resolve().then(() => updateUI());
      }
      
      return proxyInstance;
    }
  });

  // Hook 4: Map.prototype.set - detect gm and paint preview
  OriginalMap.prototype.set = new Proxy(originalMapSet, {
    apply(target: any, thisArg: any, args: any[]) {
      const [key, value] = args;
      
      // Detect gm module
      if (!gmDetected && value && value.gm) {
        gmDetected = true;
        gm = value.gm;
        page._gm = value.gm;
      }
      
      // Detect paint preview tiles and crosshair
      if (value && value.input && value.input.id) {
        const inputId = value.input.id;
        
        if (typeof inputId === 'string' && inputId.startsWith('paint-preview')) {
          paintPreviewTiles = thisArg;
        }
        
        if (inputId === 'paint-crosshair') {
          enhancePaintCrosshair(value);
        }
      }
      
      return Reflect.apply(target, thisArg, args);
    }
  });

  // Initialize backend module detection
  findModule(moduleFilters['backend']).then((x: any) => {
    user = findExport(x, (prop: any) => 
      prop && Object.getOwnPropertyNames(Object.getPrototypeOf(prop)).includes('cooldown')
    );
    
    if (!user) {
      console.warn('user property not found in backend module');
      return;
    }
    
    page._user = user;

    const userProto = Object.getPrototypeOf(user);
    const cooldownOrig = Object.getOwnPropertyDescriptor(userProto, 'cooldown');
    
    Object.defineProperty(userProto, 'cooldownOrig', cooldownOrig);
    Object.defineProperty(userProto, 'cooldown', {
      get: function() {
        return Math.ceil(cooldownOrig!.get!.call(this) / 1000.0) * 1000.0;
      },
      configurable: true
    });

    new BroadcastChannel('user-channel').onmessage = () => {
      updateUI();
    };
  });
}

// Separated paint crosshair enhancement logic
function enhancePaintCrosshair(crosshairValue: any) {
  try {
    const normalImg: HTMLImageElement = crosshairValue.input.img;
    
    // Create red-tinted version
    const redCanvas = createCanvas(normalImg.width, normalImg.height);
    const redCtx = redCanvas.getContext('2d', { willReadFrequently: true })! as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    
    redCtx.drawImage(normalImg, 0, 0);
    redCtx.globalCompositeOperation = 'multiply';
    redCtx.fillStyle = '#ff8080';
    redCtx.fillRect(0, 0, redCanvas.width, redCanvas.height);
    redCtx.globalCompositeOperation = 'destination-in';
    redCtx.drawImage(normalImg, 0, 0);
    
    (redCanvas as any).naturalWidth = redCanvas.width;
    (redCanvas as any).naturalHeight = redCanvas.height;

    // Store original place function
    const originalPlace = crosshairValue.place;
    
    // Override place function
    crosshairValue.place = function(
      latLon: [number, number], 
      customData?: { 
        painted?: [number, number, number, number], 
        current?: [number, number, number, number] 
      }
    ) {
      let imageToUse: typeof normalImg | typeof redCanvas = normalImg;
      
      try {
        const tileAndPixel: {
          tile: [number, number],
          pixel: [number, number]
        } = this.gm.latLonToTileAndPixel(...latLon, this.input.zoom);
        
        const tile = tileAndPixel.tile;
        const pixel = tileAndPixel.pixel;
        
        const pixelsFloor = this.gm.latLonToPixelsFloor(...latLon, this.input.zoom);
        const canvasPosition = this.getCanvasPos(pixelsFloor);
        
        // Track painting annotation
        const tileKey = tile[0] * 100000 + tile[1];
        if (!paintingAnnotations.has(tileKey)) {
          paintingAnnotations.set(tileKey, []);
        }
        
        paintingAnnotations.get(tileKey)!.push({
          crosshair: this,
          latLon: latLon,
          pixel: pixel,
          canvasPos: canvasPosition
        });

        // Determine painted color
        let paintedColor: [number, number, number, number] | undefined;
        if (customData && customData.painted) {
          paintedColor = customData.painted;
        } else {
          const previewTile = paintPreviewTiles.get(`${tile[0]},${tile[1]}`);
          if (previewTile && previewTile.canvas) {
            const colors = pickColorsOnCanvas(
              previewTile.canvas,
              [{ x: pixel[0], y: previewTile.canvas.height - pixel[1] - 1 }]
            );
            paintedColor = colors[0];
          }
        }

        // Determine current color
        let currentColor: [number, number, number, number] | undefined;
        if (customData && customData.current) {
          currentColor = customData.current;
        } else {
          const colors = pickColorsOnMapLayer(
            'pixel-art-layer',
            { x: tile[0], y: tile[1] },
            [{ x: pixel[0], y: pixel[1] }]
          );
          currentColor = colors[0];
        }

        // Use red image if colors match
        if (paintedColor && paintedColor.length === 4 &&
            currentColor && currentColor.length === 4 &&
            currentColor.every((val, idx) => val === paintedColor[idx])) {
          imageToUse = redCanvas;
        }

        // Update images if needed
        if (this.input.img !== imageToUse) {
          this.input.img = imageToUse;
          for (const [, canvas] of this.canvases) {
            canvas.input.img = imageToUse;
          }
        }
      } catch (err) {
        console.error('Overlay Pro: Paint crosshair error', err);
      }
      
      return originalPlace.call(this, latLon);
    };
  } catch (err) {
    console.error('Overlay Pro: Crosshair enhancement failed', err);
  }
}

let paintPreviewTiles: any;
const paintingAnnotations = new window.Map<number, any[]>();

async function onMap() {
  // Update crosshair if tile updates while painting
  map!.on('sourcedata', (e: any) => {
    if (!e.coord || !e.tile || !e.sourceId) return;
    if (e.sourceId !== 'pixel-art-layer') return;

    for (const [tileKey, annotations] of paintingAnnotations) {
      const tile = {
        x: Math.floor(tileKey / 100000),
        y: tileKey % 100000
      };

      if (e.coord.canonical.x !== tile.x || e.coord.canonical.y !== tile.y) {
        continue;
      }

      const previewTile = paintPreviewTiles.get(`${tile.x},${tile.y}`);
      const previewCanvas: HTMLCanvasElement | undefined = previewTile?.canvas;
      
      const painted = previewCanvas ? 
        pickColorsOnCanvas(
          previewCanvas,
          annotations.map(a => ({
            x: a.pixel[0],
            y: previewCanvas.height - a.pixel[1] - 1
          }))
        ) : [];
      
      const current = pickColorsOnMapLayer(
        'pixel-art-layer',
        tile,
        annotations.map(a => ({ x: a.pixel[0], y: a.pixel[1] }))
      );

      const annotationCount = annotations.length;
      for (let i = 0; i < annotationCount; i++) {
        const annotation = annotations.shift();
        const { crosshair, latLon, canvasPos } = annotation;
        
        const canvas = crosshair.canvases.get(canvasPos.key);
        if (!canvas || !canvas.annotations.has(
          canvas.getPixelKey(canvasPos.innerPos.x, canvasPos.innerPos.y)
        )) {
          continue;
        }

        crosshair.remove(latLon);
        crosshair.place(latLon, {
          painted: painted.length ? painted[i] : undefined,
          current: current.length ? current[i] : undefined
        });
      }
    }
  });

  clearOverlayCache();
  await updateOverlays();
  updateUI();
}

let fbo: WebGLFramebuffer | undefined;

function pickColorsOnMapTexture(
  texture: WebGLTexture,
  points: { x: number, y: number }[]
): [number, number, number, number][] {
  if (points.length === 0) return [];
  
  const gl = map!.painter.context.gl;
  
  if (!fbo) {
    fbo = gl.createFramebuffer();
  }

  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0
  );

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('framebuffer incomplete', status);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    return [];
  }

  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const data = new Uint8Array(w * h * 4);
  
  gl.readPixels(minX, minY, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);

  const result: [number, number, number, number][] = [];
  for (const point of points) {
    const index = ((point.y - minY) * w + (point.x - minX)) * 4;
    result.push([
      data[index + 0],
      data[index + 1],
      data[index + 2],
      data[index + 3]
    ]);
  }
  
  return result;
}

function pickColorsOnMapLayer(
  layerId: string,
  tile: { x: number, y: number },
  points: { x: number, y: number }[]
): [number, number, number, number][] {
  if (!map || !map.style || !map.style.sourceCaches) return [];
  
  const sourceCache = map.style.sourceCaches[layerId];
  if (!sourceCache) return [];

  const visibleCoords = sourceCache.getVisibleCoordinates();
  const coord = visibleCoords.find((c: any) => 
    c.canonical.x === tile.x && c.canonical.y === tile.y
  );
  
  if (!coord) return [];

  const tileTile = sourceCache.getTileByID(coord.key);
  if (!tileTile || !tileTile.texture || !tileTile.texture.texture) {
    return [];
  }

  return pickColorsOnMapTexture(tileTile.texture.texture, points);
}

function pickColorsOnCanvas(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  points: { x: number, y: number }[]
): [number, number, number, number][] {
  if (points.length === 0) return [];
  if (!canvas) return [];

  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  if (!ctx) return [];

  const imageData = ctx.getImageData(minX, minY, w, h);
  const data = imageData.data;

  const result: [number, number, number, number][] = [];
  for (const point of points) {
    const index = ((point.y - minY) * w + (point.x - minX)) * 4;
    result.push([
      data[index + 0],
      data[index + 1],
      data[index + 2],
      data[index + 3]
    ]);
  }
  
  return result;
}
