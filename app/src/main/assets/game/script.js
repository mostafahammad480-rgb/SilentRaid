(() => {
  'use strict';

  const canvas = document.getElementById('gameCanvas');
  const W = 800, H = 600;
  const RENDER_SCALE = 2;
  canvas.width = W * RENDER_SCALE;
  canvas.height = H * RENDER_SCALE;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;

  const screens = {
    MENU: document.getElementById('menuScreen'),
    PLAYING: document.getElementById('gameScreen'),
    SUCCESS: document.getElementById('successScreen'),
    FAILURE: document.getElementById('failureScreen'),
    LEVELS: document.getElementById('levelSelectScreen')
  };

  let gameState = 'MENU';
  let isMapFullyLoaded = false;
  let isGameOver = false;
  let isMuted = false;
  let audio = null;
  let vaultAudio = null;
  let escapeAudio = null;
  let mainTitleMusic = null;
  let mainTitleFadeTimer = 0;
  let resultMusic = null;
  let gameOverMusic = null;
  let resultMusicFadeTimer = 0;
  let resultTransitioning = false;
  let lastFrame = performance.now();
  let gameFrameRaf = 0;
  let gameLoopActive = false;

  const input = { x: 0, y: 0, keys: new Set(), joystickActive: false };
  const level = { stage: 1, level: 1, turn: 1, totalLevels: 15 };
  const UNLOCK_KEY = 'silent_raid_v60_unlocked_rounds_v1';
  const DEFAULT_UNLOCKED = 1;
  function getUnlockedTurn(){
    try{
      const n=Number(localStorage.getItem(UNLOCK_KEY));
      return Number.isFinite(n)&&n>=1 ? Math.min(15,Math.floor(n)) : DEFAULT_UNLOCKED;
    }catch(_){ return DEFAULT_UNLOCKED; }
  }
  function isRoundUnlocked(stage,round){ return ((stage-1)*5)+round <= getUnlockedTurn(); }
  function markRoundCompleted(stage,round){
    const completed=((stage-1)*5)+round;
    const next=Math.min(15,completed+1);
    try{ localStorage.setItem(UNLOCK_KEY,String(Math.max(getUnlockedTurn(),next))); }catch(_){}
  }
  // Pixabay main-title requested by the user: https://pixabay.com/music/main-title-intro-intro-song-576574/
  // The local MP3 is expected at assets/main-title.mp3 so the game remains offline-ready.
  const STAGE_META = [
    { name: 'المرحلة الأولى', subtitle: 'بداية التسلل', tone: 'green' },
    { name: 'المرحلة الثانية', subtitle: 'مراقبة مشددة', tone: 'blue' },
    { name: 'المرحلة الثالثة', subtitle: 'التحدي النهائي', tone: 'red' }
  ];
  let world = null;

  const DIFF = {
    1: { corridor: 3, room: 5 },
    2: { corridor: 3, room: 5 },
    3: { corridor: 2, room: 4 },
    4: { corridor: 2, room: 4 },
    5: { corridor: 1, room: 3 }
  };

  function setState(next) {
    const leavingResult = (gameState==='SUCCESS'||gameState==='FAILURE') && next!=='SUCCESS' && next!=='FAILURE';
    if(next!=='SUCCESS' && next!=='FAILURE') stopResultRain();
    if(leavingResult) fadeResultMusicOut(()=>setGameplayMusicAfterResult());
    gameState = next;
    // The game simulation/render loop is only needed while actually playing.
    // Keeping the 60fps loop alive on MENU/LEVELS was unnecessary main-thread work
    // and competed directly with the menu compositor animation.
    if(next==='PLAYING') startGameRenderLoop(); else stopGameRenderLoop();
    Object.entries(screens).forEach(([key, el]) => {
      if(!el) return;
      const active = key === next;
      el.classList.toggle('active', active);
      el.setAttribute('aria-hidden', active ? 'false' : 'true');
      // Never force display/opacity on result screens here. Their normal .screen/.screen.active
      // CSS contract is what keeps them hidden at boot and visible only after a real result.
      el.style.removeProperty('position');
      el.style.removeProperty('inset');
      el.style.removeProperty('z-index');
      el.style.removeProperty('display');
      el.style.removeProperty('opacity');
      el.style.removeProperty('visibility');
      el.style.removeProperty('pointer-events');
    });
    if (next !== 'PLAYING') resetInput();

    // The uploaded MP3 is the single background track for MENU + LEVELS.
    // Keep the same HTMLAudioElement alive so playback position is continuous
    // while moving from the main menu to the round-selection screen.
    if(next==='MENU'){ fadeMainTitleIn(false); }
    else if(next==='LEVELS'){ fadeMainTitleIn(false); }
    else { fadeMainTitleOut(); }
  }

  function resetInput() { input.x = 0; input.y = 0; input.keys.clear(); input.joystickActive = false; }

  class RNG {
    constructor(seed) { this.s = seed >>> 0; }
    next() { this.s = (1664525 * this.s + 1013904223) >>> 0; return this.s / 4294967296; }
    int(a, b) { return Math.floor(this.next() * (b - a + 1)) + a; }
  }

  function hashSeed(stage, lvl, turn) {
    const t = Date.now() >>> 0;
    return (t ^ (stage * 73856093) ^ (lvl * 19349663) ^ (turn * 83492791)) >>> 0;
  }

  function buildMaze(seed) {
    const rng = new RNG(seed);
    const d = DIFF[level.level];
    // Passage width: each navigable cell is deliberately ~1.5x the old physical width.
    // The grid topology stays unchanged so pathfinding remains stable.
    const cell = level.level <= 2 ? 38 : level.level <= 4 ? 34 : 30;
    const cols = Math.floor((W - 22) / cell), rows = Math.floor((H - 66) / cell);
    const grid = Array.from({ length: rows }, () => Array(cols).fill(1));
    const walk = [];

    function carve(x, y) {
      grid[y][x] = 0; walk.push([x, y]);
      const dirs = [[2,0],[-2,0],[0,2],[0,-2]];
      for (let i = dirs.length - 1; i > 0; i--) { const j = rng.int(0, i); [dirs[i], dirs[j]] = [dirs[j], dirs[i]]; }
      dirs.forEach(([dx,dy]) => {
        const nx=x+dx, ny=y+dy;
        if (nx>0 && ny>0 && nx<cols-1 && ny<rows-1 && grid[ny][nx]===1) { grid[y+dy/2][x+dx/2]=0; carve(nx,ny); }
      });
    }
    carve(1, 1);

    // Turn the raw maze into a bank floorplan with dependable escape routes.
    // We keep decorative walls, but deliberately remove terminal dead-end pockets
    // from the navigable graph so the player can never be trapped at a corridor tip.
    function neighbors4(x,y){
      return [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>[x+dx,y+dy]);
    }
    const loopBudget = Math.max(10, Math.floor((cols * rows) * (level.level <= 2 ? 0.055 : level.level <= 4 ? 0.045 : 0.035)));
    for (let pass = 0; pass < loopBudget; pass++) {
      const candidates = [];
      for (let y = 1; y < rows - 1; y++) {
        for (let x = 1; x < cols - 1; x++) {
          if (grid[y][x] !== 1) continue;
          const floorNeighbors = neighbors4(x,y).filter(([nx,ny])=>grid[ny]?.[nx]===0).length;
          // Prefer punching through walls that join two existing corridors.
          if (floorNeighbors >= 2) candidates.push([x,y]);
        }
      }
      if (!candidates.length) break;
      const [wx, wy] = candidates[rng.int(0, candidates.length - 1)];
      grid[wy][wx] = 0;
    }

    // Hard 2-core cleanup: repeatedly open a neighboring wall for every terminal
    // floor tile until the playable graph has no corridor end-pockets. This is
    // intentionally stronger than the old four-pass cleanup and runs before
    // objectives, hazards, cameras, and guards are placed.
    for (let pass = 0; pass < 32; pass++) {
      const deadEnds = [];
      for (let y = 1; y < rows - 1; y++) {
        for (let x = 1; x < cols - 1; x++) {
          if (grid[y][x] !== 0) continue;
          const n = neighbors4(x,y).filter(([nx,ny])=>grid[ny]?.[nx]===0).length;
          if (n <= 1 && !(x===1&&y===1)) deadEnds.push([x,y]);
        }
      }
      if (!deadEnds.length) break;
      let changed = false;
      for (const [x,y] of deadEnds) {
        const walls = neighbors4(x,y).filter(([nx,ny])=>nx>0&&ny>0&&nx<cols-1&&ny<rows-1&&grid[ny][nx]===1);
        if (!walls.length) continue;
        let best=-Infinity, chosen=[];
        for (const [wx,wy] of walls) {
          const score = neighbors4(wx,wy).filter(([ax,ay])=>grid[ay]?.[ax]===0).length * 10
            + neighbors4(wx,wy).filter(([ax,ay])=>grid[ay]?.[ax]===0 && !(ax===x&&ay===y)).length * 2
            + rng.next()*1.5;
          if(score>best){best=score;chosen=[[wx,wy]];} else if(Math.abs(score-best)<0.001) chosen.push([wx,wy]);
        }
        const [ox,oy]=chosen[rng.int(0,chosen.length-1)];
        grid[oy][ox]=0;
        changed = true;
      }
      if (!changed) break;
    }

    // Final dead-end bridge pass. Some edge pockets can require more than one
    // wall opening to reconnect to the main floor. For every remaining terminal
    // tile, carve the shortest wall corridor to a different floor tile. This makes
    // the playable topology looped rather than terminating at a pocket.
    function bridgeDeadEnds(){
      for(let pass=0;pass<80;pass++){
        const deadEnds=[];
        for(let y=0;y<rows;y++) for(let x=0;x<cols;x++){
          if(grid[y][x]!==0) continue;
          const n=neighbors4(x,y).filter(([nx,ny])=>grid[ny]?.[nx]===0).length;
          if(n<=1) deadEnds.push([x,y]);
        }
        if(!deadEnds.length) return;
        let changed=false;
        for(const [sx,sy] of deadEnds){
          const floorNeighbors=neighbors4(sx,sy).filter(([nx,ny])=>grid[ny]?.[nx]===0);
          const backKey=floorNeighbors[0]?floorNeighbors[0].join(','):null;
          const q=[[sx,sy]], prev=new Map([[sx+','+sy,null]]);
          let goal=null;
          for(let qi=0;qi<q.length&&!goal;qi++){
            const [x,y]=q[qi];
            for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
              const nx=x+dx,ny=y+dy,key=nx+','+ny;
              if(nx<0||ny<0||nx>=cols||ny>=rows||prev.has(key)) continue;
              prev.set(key,[x,y]);
              if(grid[ny][nx]===0 && key!==backKey && !(nx===sx&&ny===sy)){goal=[nx,ny];break;}
              q.push([nx,ny]);
            }
          }
          if(!goal) continue;
          let cur=goal,carve=[];
          while(cur){
            carve.push(cur);
            cur=prev.get(cur[0]+','+cur[1])||null;
          }
          for(const [x,y] of carve) grid[y][x]=0;
          changed=true;
        }
        if(!changed) break;
      }
    }
    bridgeDeadEnds();

    // Widen corridors for early levels while keeping the maze grid-like.
    if (d.corridor > 1) {
      for (let y=1;y<rows-1;y++) for (let x=1;x<cols-1;x++) {
        if (grid[y][x]!==0 || rng.next()>=0.11*d.corridor) continue;
        const [cx,cy]=rng.next()<.5?[Math.min(cols-2,x+1),y]:[x,Math.min(rows-2,y+1)];
        if(grid[cy][cx]!==1) continue;
        const support=neighbors4(cx,cy).filter(([nx,ny])=>grid[ny]?.[nx]===0).length;
        // Only widen through a wall that already joins two floor tiles. Opening
        // a wall with one support cell would create a fresh terminal dead-end.
        if(support>=2) grid[cy][cx]=0;
      }
    }

    // Final topology repair after widening: the exact grid delivered to the
    // game never leaves a terminal pocket at the end of a corridor.
    bridgeDeadEnds();

    const ox = Math.floor((W-cols*cell)/2), oy = 38 + Math.floor((H-68-rows*cell)/2);
    const isFloor = (x,y) => x>=0&&y>=0&&x<cols&&y<rows&&grid[y][x]===0;
    const toWorld = (x,y) => ({x:ox+x*cell+cell/2,y:oy+y*cell+cell/2});

    const floor = [];
    for (let y=1;y<rows-1;y++) for (let x=1;x<cols-1;x++) if (isFloor(x,y)) floor.push([x,y]);
    const farthestFrom = (start) => {
      const q=[start], dist=new Map([[start.join(','),0]]), prev=new Map(); let best=start;
      for(let i=0;i<q.length;i++){
        const [x,y]=q[i]; const dd=dist.get(x+','+y);
        if(dd>dist.get(best.join(','))) best=[x,y];
        [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>{
          const nx=x+dx,ny=y+dy,k=nx+','+ny;
          if(isFloor(nx,ny)&&!dist.has(k)){dist.set(k,dd+1);prev.set(k,[x,y]);q.push([nx,ny]);}
        });
      }
      return {cell:best,dist,prev};
    };

    const start = [1,1];
    const end1 = farthestFrom(start).cell;
    const end2 = farthestFrom(end1).cell;
    const end3 = farthestFrom(end2).cell;
    const reserved = new Set([start.join(','), end1.join(','), end2.join(','), end3.join(',')]);
    const pickFar = (from, used, minD=10) => {
      let best=null,bestD=-1; const data=farthestFrom(from);
      floor.forEach(p=>{ const k=p.join(','); if(used.has(k)||reserved.has(k)) return; const dd=data.dist.get(k)||0; if(dd>=minD&&dd>bestD){best=p;bestD=dd;} });
      return best || floor[rng.int(0,floor.length-1)];
    };

    const pickerNoise=(r)=>r.next();
    const playerCell=start;
    const used = new Set([playerCell.join(',')]);
    // Spread the three vault keys across the bank so they can never spawn side-by-side.
    const keyCells=[];
    const keyMinGap=Math.max(8,Math.floor(cols*.22));
    for(let i=0;i<3;i++){
      let best=null,bestScore=-1;
      for(const c of floor){
        const k=c.join(','); if(used.has(k)||reserved.has(k)) continue;
        const minToUsed=[...used].reduce((m,key)=>{const [ux,uy]=key.split(',').map(Number);return Math.min(m,Math.abs(c[0]-ux)+Math.abs(c[1]-uy));},Infinity);
        if(minToUsed<keyMinGap) continue;
        const centerD=Math.abs(c[0]-Math.floor(cols/2))+Math.abs(c[1]-Math.floor(rows/2));
        const score=minToUsed*2+centerD*.25+pickerNoise(rng)*2;
        if(score>bestScore){bestScore=score;best=c;}
      }
      if(!best){
        let fallback=null,fd=-1;
        for(const c of floor){const k=c.join(',');if(used.has(k)||reserved.has(k))continue;const md=[...used].reduce((m,key)=>{const [ux,uy]=key.split(',').map(Number);return Math.min(m,Math.abs(c[0]-ux)+Math.abs(c[1]-uy));},Infinity);if(md>fd){fd=md;fallback=c;}}
        best=fallback||floor[rng.int(0,floor.length-1)];
      }
      keyCells.push(best); used.add(best.join(','));
    }
    let cursor=keyCells[keyCells.length-1]||playerCell;
    const vaultCell=pickFar(cursor,used,Math.max(10,Math.floor(cols/2))); used.add(vaultCell.join(','));
    const escapeCell=pickFar(vaultCell,used,Math.max(10,Math.floor(cols/2)));

    const p=toWorld(...playerCell), vault=toWorld(...vaultCell), escape=toWorld(...escapeCell);
    const keys=keyCells.map(c=>({...toWorld(...c),collected:false,cell:c}));

    const guardCount = level.stage;
    const guards=[];
    const occupied=new Set([playerCell.join(','),vaultCell.join(','),escapeCell.join(','),...keyCells.map(c=>c.join(','))]);
    // Never spawn a guard in the player's opening sector. Pick spawn cells by
    // actual path distance from the player so the first patrol begins elsewhere.
    const spawnData=bfsDistancesFrom(grid, playerCell);
    const spawnCandidates=floor.filter(c=>!occupied.has(c.join(',')) && (spawnData.get(c.join(','))||0)>=Math.max(18, Math.floor((cols+rows)*0.45)));
    const shuffled=spawnCandidates.length?spawnCandidates:[...floor].filter(c=>!occupied.has(c.join(',')));
    shuffled.sort(()=>rng.next()-.5);
    let gi=0;
    while(gi<guardCount && shuffled.length){
      let bestIdx=-1,bestScore=-Infinity;
      for(let i=0;i<Math.min(shuffled.length,80);i++){
        const c=shuffled[i], d0=spawnData.get(c.join(','))||0;
        const separation=Math.min(...guards.map(g=>Math.abs(c[0]-g.cell[0])+Math.abs(c[1]-g.cell[1])));
        const score=d0*3 + (guards.length?separation*2:0) + rng.next()*12;
        if(score>bestScore){bestScore=score;bestIdx=i;}
      }
      const c=shuffled.splice(Math.max(0,bestIdx),1)[0];
      guards.push(makeGuard(toWorld(...c), c, rng, gi, seed)); occupied.add(c.join(',')); gi++;
    }

    // Give every guard an independent patrol territory. They may all chase the
    // same player, but their normal patrol targets come from different regions,
    // so multiple guards do not behave like one synchronized unit.
    guards.forEach((g, index) => {
      const local = guards.length <= 1 ? floor.slice() : floor.filter(c => {
        let owner = 0, ownerD = Infinity;
        for (let j=0;j<guards.length;j++) {
          const d=Math.abs(c[0]-guards[j].cell[0])+Math.abs(c[1]-guards[j].cell[1]);
          if(d<ownerD){ownerD=d;owner=j;}
        }
        return owner===index;
      });
      g.patrolCells = (local.length>=8 ? local : floor.slice()).map(c=>c.slice());
      g.patrolPhase = g.patrolRng.next()*Math.PI*2;
    });

    const hazards=[];
    const doors=[];
    const cameras=[];
    for(let i=0;i<Math.min(8,Math.floor(floor.length/90));i++){
      const c=floor[rng.int(0,floor.length-1)];
      if(Math.abs(c[0]-playerCell[0])+Math.abs(c[1]-playerCell[1])<5) continue;
      const q=toWorld(...c); hazards.push({x:q.x,y:q.y,r:Math.max(6,cell*.25),cool:0});
    }
    for(let i=0;i<Math.min(4 + level.level,Math.floor(floor.length/120));i++){
      const c=floor[rng.int(0,floor.length-1)], q=toWorld(...c); doors.push({x:q.x,y:q.y,w:cell*.9,h:cell*.18,open:0,orient:rng.next()<.5?'h':'v'});
    }
    for(let i=0;i<Math.min(5 + level.level,Math.floor(floor.length/55));i++){
      const c=floor[rng.int(0,floor.length-1)], q=toWorld(...c);
      if(Math.abs(c[0]-playerCell[0])+Math.abs(c[1]-playerCell[1])<7) continue;
      cameras.push({x:q.x,y:q.y,angle:rng.next()*Math.PI*2,sweep:rng.next()<.5?1:-1,phase:rng.next()*Math.PI*2,trigger:0,scanTimer:0});
    }

    const perfectTime = computePerfectTime(grid, playerCell, keyCells, vaultCell, escapeCell, cell) * .075 + 10;
    const bonus=[110,90,80,70,65][level.level-1];

    return {seed,rng,cell,cols,rows,ox,oy,grid,floorCells:floor.map(c=>c.slice()),keys,vault,escape,guards,hazards,doors,cameras,backgroundCanvas:null,guardSpeed:88 + (level.level-1)*3 + (level.stage-1)*2,wallsDiscovered:[],wallMemory:0,standstill:0,lightRadius:190,perfectTime,timer:Math.max(20,(perfectTime+bonus)-10),radarPulses:[],crumbs:[],vaultOpen:false,vaultOpened:false,escapeArmed:false,lockdown:false,spawned:true,explosionFlash:0,lastPlayerMoving:false,alarmUntil:0,alarmTarget:null,objectiveFlash:0,musicBeat:0,timerRunning:false};
  }

  function bfsDistancesFrom(grid, start){
    const h=grid.length,w=grid[0].length,q=[start],d=new Map([[start.join(','),0]]);
    for(let i=0;i<q.length;i++){
      const [x,y]=q[i],cur=d.get(x+','+y);
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nx=x+dx,ny=y+dy,k=nx+','+ny;
        if(nx>=0&&ny>=0&&nx<w&&ny<h&&grid[ny][nx]===0&&!d.has(k)){d.set(k,cur+1);q.push([nx,ny]);}
      }
    }
    return d;
  }

  function makeGuard(pos, cell, rng, index=0, seed=0){
    const patrolRng = new RNG((seed ^ (0x9E3779B9 + index * 0x85EBCA6B)) >>> 0);
    const patrolSpeed = Number.isFinite(world?.guardSpeed) ? world.guardSpeed : 88 + (level.level-1)*3 + (level.stage-1)*2;
    return {x:pos.x,y:pos.y,radius:8,cell:cell.slice(),vx:0,vy:0,lastKnown:{x:pos.x,y:pos.y},target:{x:pos.x,y:pos.y},state:'PATROL',patrol:null,patrolCooldown:0.8+patrolRng.next()*1.8,patrolWait:0.15+patrolRng.next()*0.8,patrolHistory:[],stepTimer:patrolRng.next()*.5,phase:patrolRng.next()*Math.PI*2,pulse:0,patrolRng,patrolCells:[],patrolSpeed,faceDir:{x:1,y:0},pathTimer:0,path:[],pathIndex:1,pathTarget:null,losTimer:0,alertTimer:0,chaseUntil:0,blockedFrames:0,stuckTime:0,lastMoveX:pos.x,lastMoveY:pos.y,stuckCooldown:0,detourCell:null};
  }

  function computePerfectTime(grid, start, keys, vault, escape, cell){
    const points=[start,...keys,vault,escape]; let total=0;
    for(let i=0;i<points.length-1;i++) total += bfsDistance(grid, points[i], points[i+1]);
    return Math.max(30,total || 80);
  }
  function bfsDistance(grid,a,b){
    const h=grid.length,w=grid[0].length,q=[a],d=new Map([[a.join(','),0]]);
    for(let i=0;i<q.length;i++){const [x,y]=q[i]; if(x===b[0]&&y===b[1]) return d.get(x+','+y); for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy,k=nx+','+ny; if(nx>=0&&ny>=0&&nx<w&&ny<h&&grid[ny][nx]===0&&!d.has(k)){d.set(k,d.get(x+','+y)+1);q.push([nx,ny]);}}} return 999;
  }

  function openLevelSelect(){
    try{ ensureAudio(); }catch(_){}
    // Returning from an active raid must kill the procedural gameplay music
    // completely. Otherwise its oscillators remain alive underneath the title
    // track and produce the unwanted buzzing/"ززز" sound on the LEVELS screen.
    try{ stopLocalMusic(); }catch(_){}
    // Keep the uploaded title MP3 as the only background music for MENU + LEVELS.
    try{ if(!isMuted) fadeMainTitleIn(false); }catch(_){}
    renderLevelSelect();
    setState('LEVELS');
  }

  function selectLevel(stage, round, startImmediately=true){
    stage=Math.max(1,Math.min(3,Number(stage)||1));
    round=Math.max(1,Math.min(5,Number(round)||1));
    if(!isRoundUnlocked(stage,round)){
      showMessage('هذا الدور مقفول — اجتز الدور السابق أولًا');
      return;
    }
    level.stage=stage;
    level.level=round;
    level.turn=((level.stage-1)*5)+level.level;
    renderLevelSelect();
    if(startImmediately) startRaid();
  }

  function renderLevelSelect(){
    const grid=document.getElementById('levelSelectGrid');
    if(!grid)return;
    grid.innerHTML=STAGE_META.map((meta,stageIndex)=>{
      const stage=stageIndex+1;
      const cards=Array.from({length:5},(_,i)=>{
        const round=i+1;
        const selected=level.stage===stage&&level.level===round;
        const global=((stage-1)*5)+round;
        const unlocked=isRoundUnlocked(stage,round);
        return `<button class="round-card ${selected?'selected ':''}${unlocked?'':'locked'}" data-stage="${stage}" data-round="${round}" ${unlocked?'':'disabled'} aria-disabled="${unlocked?'false':'true'}" aria-label="المرحلة ${stage} الدور ${round}${unlocked?'':' — مقفول'}">
          <span class="round-lock">${unlocked?'':'🔒'}</span>
          <span class="round-number">${String(round).padStart(2,'0')}</span>
          <span class="round-title">الدور ${round}</span>
          <span class="round-global">عملية ${String(global).padStart(2,'0')}</span>
          <span class="round-open">${unlocked?'مفتوح':'أكمل الدور السابق'}</span>
        </button>`;
      }).join('');
      return `<section class="stage-panel stage-${stage} ${meta.tone}">
        <div class="stage-head">
          <div class="stage-copy"><span class="stage-index">0${stage}</span><div><h3>${meta.name}</h3><p>${meta.subtitle}</p></div></div>
          <div class="stage-avatars" aria-hidden="true"><canvas class="stage-avatar stage-avatar-thief"></canvas><canvas class="stage-avatar stage-avatar-guard"></canvas></div>
        </div>
        <div class="round-grid">${cards}</div>
      </section>`;
    }).join('');
    requestAnimationFrame(renderLevelSelectActors);
  }

  function renderLevelSelectActors(){
    const canvases=document.querySelectorAll('#levelSelectGrid .stage-avatar');
    const dpr=Math.min(2,window.devicePixelRatio||1);
    canvases.forEach((canvas)=>{
      const type=canvas.classList.contains('stage-avatar-thief')?'thief':'guard';
      const size=120, scale=2.35;
      canvas.width=Math.floor(size*dpr); canvas.height=Math.floor(size*dpr);
      canvas.style.width=size+'px'; canvas.style.height=size+'px';
      const c=canvas.getContext('2d'); c.setTransform(dpr,0,0,dpr,0,0);
      c.clearRect(0,0,size,size); c.save(); c.translate(size/2,type==='thief'?size*.70:size*.68); c.scale(scale,scale);
      if(type==='thief'){
        const p={x:0,y:0,vx:0,vy:0,r:9,lastDir:{x:1,y:-.04},wobble:0};
        drawPlayerVisual(c,p,0,false,false);
      }else{
        const g={x:0,y:0,vx:0,vy:0,radius:8,faceDir:{x:-1,y:-.04},state:'PATROL',pulse:0};
        drawGuardVisual(c,g,true);
      }
      c.restore();
    });
  }

  function startRaid(){
    resultTransitioning=false;
    isGameOver=false;
    isMapFullyLoaded=false;
    setState('PLAYING');
    buildLevel();
    try { startNativeMusic(); } catch (_) {}
  }

  function buildLevel(){
    isMapFullyLoaded=false; isGameOver=false; world=null; updateHUD();
    const nextWorld=buildMaze(hashSeed(level.stage,level.level,level.turn));
    const pCell=nextWorld.grid.length ? [1,1] : [0,0];
    const p=worldToCanvas(nextWorld,pCell[0],pCell[1]);
    nextWorld.player={x:p.x,y:p.y,vx:0,vy:0,r:9,lastDir:{x:1,y:0},wobble:0,opacity:1,keys:0};
    world=nextWorld;
    world.timerRunning=true;
    isMapFullyLoaded = Array.isArray(world.grid)&&world.grid.length>0&&world.player&&Number.isFinite(world.player.x)&&Number.isFinite(world.player.y)&&world.keys.length===3;
    updateHUD();
  }
  function worldToCanvas(w,gx,gy){ return {x:w.ox+gx*w.cell+w.cell/2,y:w.oy+gy*w.cell+w.cell/2}; }

  function updateHUD(){
    const stageName=STAGE_META[level.stage-1]?.name||`المرحلة ${level.stage}`;
    const levelHud=document.getElementById('levelHud');
    if(levelHud) levelHud.textContent=`${stageName} • الدور ${level.level}/5`;
    const sec=Math.max(0,Math.floor((world?.timer||0)+0.0001));
    const mm=String(Math.floor(sec/60)).padStart(2,'0'), ss=String(sec%60).padStart(2,'0');
    const timerHud=document.getElementById('timerHud'); if(timerHud) timerHud.textContent=`الوقت المتبقي: ${mm}:${ss}`;
    const keysHud=document.getElementById('keysHud'); if(keysHud) keysHud.textContent=`المفاتيح: ${world?.player?.keys||0}/3`;
    const chaseHud=document.getElementById('chaseHud');
    const chasing=!!world?.guards?.some(g=>g.state==='CHASE');
    if(chaseHud){
      chaseHud.hidden=!chasing;
      if(chasing) chaseHud.textContent='⚠ المطاردة نشطة';
    }
  }

  function canStandAt(x,y,r){
    if(!world) return false;
    const minX=Math.floor((x-r-world.ox)/world.cell), maxX=Math.floor((x+r-world.ox)/world.cell);
    const minY=Math.floor((y-r-world.oy)/world.cell), maxY=Math.floor((y+r-world.oy)/world.cell);
    for(let gy=minY;gy<=maxY;gy++) for(let gx=minX;gx<=maxX;gx++){
      if(!isFloor(gx,gy)) return false;
    }
    return true;
  }

  // Guard movement MUST use the same collision contract as the player.
  // The previous build called this function without defining it, so the
  // exception was swallowed by the guarded AI subsystem and every guard
  // stopped before reaching its movement/capture logic.
  function canGuardStandAt(x,y,r){
    return canStandAt(x,y,r);
  }
  function collideCircleWalls(x,y,r){ return canStandAt(x,y,r)?{x,y}:{x:x,y:y}; }
  function canvasToGrid(x,y){return {x:Math.floor((x-world.ox)/world.cell),y:Math.floor((y-world.oy)/world.cell)}}
  function isFloor(gx,gy){return gx>=0&&gy>=0&&gx<world.cols&&gy<world.rows&&world.grid[gy][gx]===0}

  function getMoveInput(){
    let x=input.x,y=input.y;
    if(!input.joystickActive){x=0;y=0; if(input.keys.has('a')||input.keys.has('arrowleft')) x-=1; if(input.keys.has('d')||input.keys.has('arrowright')) x+=1; if(input.keys.has('w')||input.keys.has('arrowup')) y-=1; if(input.keys.has('s')||input.keys.has('arrowdown')) y+=1;}
    const m=Math.hypot(x,y); return m>0?{x:x/m,y:y/m,mag:Math.min(1,m)}:{x:0,y:0,mag:0};
  }

  function update(dt,now){
    if(gameState!=='PLAYING' || !isMapFullyLoaded || !world?.player || isGameOver) return;
    const p=world.player;

    // Fixed-step simulation keeps timer, pickup and AI deterministic across refresh rates.
    try{
      const mv=getMoveInput();
      const running=mv.mag>.15;
      const maxSpeed=running?150:110;
      const accel=running?1000:750;
      p.vx += (mv.x*maxSpeed-p.vx)*Math.min(1,accel*dt/Math.max(1,maxSpeed));
      p.vy += (mv.y*maxSpeed-p.vy)*Math.min(1,accel*dt/Math.max(1,maxSpeed));
      if(!running){ p.vx*=Math.pow(.04,dt); p.vy*=Math.pow(.04,dt); }

      // Axis-separated collision: blocked velocity is cancelled immediately.
      const nextX=p.x+p.vx*dt;
      if(canStandAt(nextX,p.y,p.r)) p.x=nextX; else p.vx=0;
      const nextY=p.y+p.vy*dt;
      if(canStandAt(p.x,nextY,p.r)) p.y=nextY; else p.vy=0;

      const actualSpeed=Math.hypot(p.vx,p.vy);
      if(actualSpeed>2){p.lastDir.x=p.vx/actualSpeed;p.lastDir.y=p.vy/actualSpeed;}
      const targetWobble=actualSpeed>15?1:0;
      p.wobble += ((targetWobble-p.wobble)*Math.min(1,dt*10));
      world.lastPlayerMoving=actualSpeed>15;
      world.objectiveFlash=Math.max(0,(world.objectiveFlash||0)-dt);

      if(actualSpeed<15){
        world.standstill+=dt;
        world.wallMemory=Math.max(0,5-world.standstill);
      }else{
        world.standstill=0; world.wallMemory=5;
        world.wallsDiscovered=collectNearbyWalls();
      }
      // Smooth light state: the vision radius follows movement with damping instead of
      // jumping between fully lit and dark. The transition is intentionally slower
      // than the player animation to create a soft, cinematic breathing effect.
      const lightTarget=actualSpeed>15?190:0;
      const lightResponse=actualSpeed>15?7.5:3.6;
      world.lightRadius += (lightTarget-world.lightRadius)*(1-Math.exp(-lightResponse*dt));
      world.lightRadius=Math.max(0,Math.min(190,world.lightRadius));

      // The clock is intentionally updated BEFORE AI/cameras so a fault in any
      // expensive subsystem can never silently stop the countdown or HUD.
      updateTimer(dt);
      updatePlayerObjectives();

      const subsystems=[
        ['camera',()=>updateSecurityCameras(dt,now,actualSpeed)],
        ['guards',()=>updateGuards(dt,now,actualSpeed)],
        ['hazards',()=>updateHazardsAndDoors(dt,actualSpeed)],
        ['failure',()=>checkFailureAndSuccess()],
        ['audio',()=>updateAudio(dt)]
      ];
      for(const [name,fn] of subsystems){
        try{fn();}catch(err){
          console.error(`Silent Raid ${name} subsystem error`,err);
          if(name==='guards') world.guardRuntimeError=String(err?.message||err);
        }
        if(isGameOver) break;
      }
    }catch(err){
      // Never let a single gameplay system abort the simulation loop.
      console.error('Silent Raid player subsystem error',err);
    }finally{
      try{updateHUD();}catch(err){console.error('HUD error',err);}
    }
  }

  function updatePlayerObjectives(){
    const p=world.player;
    world.keys.forEach(k=>{if(!k.collected&&dist(p,k)<=Math.max(22,p.r+13)){k.collected=true;p.keys=Math.min(3,p.keys+1);world.objectiveFlash=1;playSfx('key');showMessage(`تم الحصول على مفتاح الخزنة — ${p.keys}/3`);}});
    world.vaultOpen=p.keys===3;
    if(world.vaultOpen&&dist(p,world.vault)<18&&!world.vaultOpened){world.vaultOpened=true;playSfx('vault');showMessage('الخزنة فتحت — اذهب إلى بوابة الهروب');}
    world.escapeArmed=world.vaultOpened;
  }

  // Deterministic emergency detour used by the guard when its current
  // direction is blocked. It intentionally does not depend on a secondary
  // helper, so the chase loop cannot die from a missing function.
  function pickGuardDetour(g,targetCell){
    const c=canvasToGrid(g.x,g.y);
    const candidates=[[1,0],[-1,0],[0,1],[0,-1]]
      .map(([dx,dy])=>[c.x+dx,c.y+dy])
      .filter(([x,y])=>isFloor(x,y));
    if(!candidates.length) return null;
    candidates.sort((a,b)=>{
      const da=Math.abs(a[0]-targetCell.x)+Math.abs(a[1]-targetCell.y);
      const db=Math.abs(b[0]-targetCell.x)+Math.abs(b[1]-targetCell.y);
      return da-db;
    });
    return candidates[0];
  }


  // Pick a locally reachable escape cell when the current movement edge is blocked.
  // The chooser prefers cells that are safe for the guard's full radius, closer to the
  // current target, and different from the cell that just caused a stall.
  function pickGuardEscapeCell(g,targetCell){
    const c=canvasToGrid(g.x,g.y);
    const currentKey=c.x+','+c.y;
    const candidates=[[1,0],[-1,0],[0,1],[0,-1]]
      .map(([dx,dy])=>[c.x+dx,c.y+dy])
      .filter(([x,y])=>isFloor(x,y))
      .filter(([x,y])=>{
        const pos=worldToCanvas(world,x,y);
        return canGuardStandAt(pos.x,pos.y,g.radius);
      })
      .filter(([x,y])=>x+','+y !== currentKey)
      .filter(([x,y])=>!g.detourCell || x+','+y !== g.detourCell.join(','));
    if(!candidates.length)return null;
    candidates.sort((a,b)=>{
      const da=Math.abs(a[0]-targetCell.x)+Math.abs(a[1]-targetCell.y);
      const db=Math.abs(b[0]-targetCell.x)+Math.abs(b[1]-targetCell.y);
      const aa=Math.atan2(a[1]-c.y,a[0]-c.x), ab=Math.atan2(b[1]-c.y,b[0]-c.x);
      const dir= Math.atan2(g.faceDir?.y||0,g.faceDir?.x||1);
      const turnA=Math.abs(Math.atan2(Math.sin(aa-dir),Math.cos(aa-dir)));
      const turnB=Math.abs(Math.atan2(Math.sin(ab-dir),Math.cos(ab-dir)));
      return (da*1.0+turnA*.18+g.patrolRng.next()*.001)-(db*1.0+turnB*.18+g.patrolRng.next()*.001);
    });
    return candidates[0];
  }

  function updateGuards(dt,now,playerSpeed){
    const p=world.player;
    const nowSec=now/1000;
    let anyChase=false;
    const SENSE_R=108;
    const VISION_R=146;
    const CAPTURE_R=p.r+10;
    const CHASE_SECONDS=6;
    const defaultGuardSpeed=Number.isFinite(world.guardSpeed)?world.guardSpeed:88;
    const MAX_MOVE_STEP=2.25;

    for(const g of world.guards){
      const d=dist(g,p);
      const visible=d<=VISION_R && hasLineOfSight(g,p);
      const cameraAlarm=(world.alarmUntil||0)>nowSec;
      const insideSense=d<=SENSE_R;
      const detectedNow=insideSense || visible || cameraAlarm;

      if(g.state!=='CHASE' && detectedNow){
        g.state='CHASE';
        g.lastKnown={x:p.x,y:p.y};
        g.target={x:p.x,y:p.y};
        g.chaseUntil=nowSec+CHASE_SECONDS;
        g.alertTimer=CHASE_SECONDS;
        g.path=[]; g.pathIndex=0; g.pathTimer=0; g.pathTarget=null;
        showMessage(cameraAlarm?'🚨 الكاميرا رصدتك! الشرطة تطاردك!':'🚨 الحارس رصدك! اهرب!');
        playAlarmSiren();
      }else if(g.state==='CHASE'){
        if(detectedNow){
          // Hard rule: the 6-second window is a grace/search window, not a timeout.
          // As long as the player remains detectable, pursuit is continuously refreshed.
          g.lastKnown={x:p.x,y:p.y};
          g.target={x:p.x,y:p.y};
          g.chaseUntil=nowSec+CHASE_SECONDS;
          g.alertTimer=CHASE_SECONDS;
          anyChase=true;
        }else if(nowSec < (g.chaseUntil||0)){
          g.target={...g.lastKnown};
          g.alertTimer=Math.max(0,g.chaseUntil-nowSec);
          anyChase=true;
        }else{
          // Lost target: leave chase only after the grace window expires while
          // the player is actually outside the sensory/LOS envelope.
          g.state='SEARCH';
          g.target={...g.lastKnown};
          g.path=[]; g.pathIndex=0; g.pathTimer=0; g.pathTarget=null;
          g.searchUntil=nowSec+3;
        }
      }else if(g.state==='SEARCH'){
        if(detectedNow){
          g.state='CHASE';
          g.lastKnown={x:p.x,y:p.y};
          g.target={x:p.x,y:p.y};
          g.chaseUntil=nowSec+CHASE_SECONDS;
          g.alertTimer=CHASE_SECONDS;
          g.path=[]; g.pathIndex=0; g.pathTimer=0; g.pathTarget=null;
          anyChase=true;
        }else if(dist(g,g.target)<10 || nowSec>(g.searchUntil||0)){
          g.state='PATROL';
          g.path=[]; g.pathIndex=0; g.patrol=null; g.pathTimer=0; g.pathTarget=null;
          g.patrolRoute=null; g.patrolRouteIndex=0;
          g.patrolCooldown=0; g.patrolWait=0;
        }
      }

      if(g.state==='PATROL'){
        g.patrolCooldown-=dt;
        if(g.patrolWait>0) g.patrolWait=Math.max(0,g.patrolWait-dt);
        const gc=canvasToGrid(g.x,g.y);
        const routeActive=Array.isArray(g.patrolRoute) && g.patrolRoute.length>1 && g.patrolRouteIndex<g.patrolRoute.length;
        if(!routeActive){
          if(g.patrolWait>0 || g.patrolCooldown>0){
            g.vx=0; g.vy=0;
          }else{
            const recent=new Set((g.patrolHistory||[]).slice(-5).map(c=>c.join(',')));
            let bestPath=[], bestScore=-Infinity;
            for(let attempt=0;attempt<40;attempt++){
              const patrolPool=(g.patrolCells?.length?g.patrolCells:world.floorCells);
              const target=patrolPool[g.patrolRng.int(0,patrolPool.length-1)];
              const tk=target.join(',');
              if((target[0]===gc.x&&target[1]===gc.y)||recent.has(tk)) continue;
              const nearOther=world.guards.some(other=>other!==g && Math.abs(target[0]-other.cell[0])+Math.abs(target[1]-other.cell[1])<4);
              if(nearOther) continue;
              const candidate=findGridPath(gc,target);
              if(candidate.length<6) continue;
              const manhattan=Math.abs(target[0]-gc.x)+Math.abs(target[1]-gc.y);
              const score=candidate.length*1.8+manhattan*.65+g.patrolRng.next()*24;
              if(score>bestScore){bestScore=score;bestPath=candidate;}
            }
            if(!bestPath.length){
              let longest=[];
              for(let attempt=0;attempt<16;attempt++){
                const patrolPool=(g.patrolCells?.length?g.patrolCells:world.floorCells);
              const target=patrolPool[g.patrolRng.int(0,patrolPool.length-1)];
                const candidate=findGridPath(gc,target);
                if(candidate.length>longest.length) longest=candidate;
              }
              bestPath=longest.length?longest:[gc];
            }
            g.patrolRoute=bestPath;
            g.patrolRouteIndex=bestPath.length>1?1:0;
            g.patrolHistory=g.patrolHistory||[];
            const finalCell=bestPath[bestPath.length-1]||gc;
            g.patrolHistory.push(finalCell.slice());
            if(g.patrolHistory.length>10) g.patrolHistory.shift();
            g.patrolCell=finalCell.slice();
            g.patrolCooldown=0;
            g.patrolWait=0;
          }
        }
        if(g.patrolRoute?.length && g.patrolRouteIndex<g.patrolRoute.length){
          const pc=g.patrolRoute[g.patrolRouteIndex];
          g.target=worldToCanvas(world,pc[0],pc[1]);
          g.path=g.patrolRoute;
          g.pathIndex=g.patrolRouteIndex;
          g.pathTarget=null;
        }else{
          g.target={x:g.x,y:g.y};
          g.path=[]; g.pathIndex=0; g.pathTarget=null;
        }
      }

      const target=g.target||{x:g.x,y:g.y};
      if(g.state==='CHASE' || g.state==='SEARCH' || g.state==='DISTRACT'){
        const tx=target.x-g.x, ty=target.y-g.y, td=Math.hypot(tx,ty);
        if(td>0.5){g.faceDir.x=tx/td;g.faceDir.y=ty/td;}
      }
      const targetCell=canvasToGrid(target.x,target.y);
      const guardCell=canvasToGrid(g.x,g.y);
      const pathState=(g.state==='CHASE'||g.state==='SEARCH'||g.state==='DISTRACT');

      // CHASE/SEARCH no longer performs a full BFS independently for every guard on a
      // timer. One flow field is computed from the current player cell and every guard
      // follows its own local downhill neighbor. The guards remain independent in their
      // patrol/state/choice logic, but the shared chase field removes repeated searches
      // that can block the JS main thread and visually freeze agents for seconds.
      if(pathState){
        const playerCellNow=canvasToGrid(p.x,p.y);
        const fieldKey=playerCellNow.x+','+playerCellNow.y;
        if(!world.guardFlowField || world.guardFlowFieldKey!==fieldKey || (world.guardFlowFieldStamp||0)<nowSec-0.08){
          const field=new Map();
          const q=[[playerCellNow.x,playerCellNow.y]];
          field.set(fieldKey,null);
          for(let qi=0;qi<q.length;qi++){
            const [cx,cy]=q[qi];
            for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
              const nx=cx+dx,ny=cy+dy,k=nx+','+ny;
              if(!isFloor(nx,ny) || field.has(k)) continue;
              field.set(k,[cx,cy]);
              q.push([nx,ny]);
            }
          }
          world.guardFlowField=field;
          world.guardFlowFieldKey=fieldKey;
          world.guardFlowFieldStamp=nowSec;
        }
        const ck=guardCell.x+','+guardCell.y;
        const next=world.guardFlowField.get(ck);
        if(next){
          g.path=[guardCell,next];
          g.pathIndex=1;
          g.pathTarget={x:targetCell.x,y:targetCell.y};
          g.pathTimer=0.12;
        }else{
          // The player may be in a disconnected region or a transient edge case.
          // Fall back to a bounded local search; never spin on the same waypoint.
          const found=findGridPath(guardCell,targetCell);
          g.path=found.length?found:[guardCell];
          g.pathIndex=g.path.length>1?1:0;
          g.pathTarget={x:targetCell.x,y:targetCell.y};
          g.pathTimer=0.20;
          if(!found.length){
            const detour=pickGuardEscapeCell(g,targetCell)||pickGuardDetour(g,targetCell);
            if(detour){g.path=[guardCell,detour];g.pathIndex=1;}
          }
        }
      }

      while(g.path?.length && g.pathIndex<g.path.length){
        const wp=worldToCanvas(world,g.path[g.pathIndex][0],g.path[g.pathIndex][1]);
        if(Math.hypot(wp.x-g.x,wp.y-g.y)<=4){
          g.x=wp.x; g.y=wp.y; g.cell=[g.path[g.pathIndex][0],g.path[g.pathIndex][1]];
          g.pathIndex++;
          if(g.state==='PATROL')g.patrolRouteIndex=g.pathIndex;
        }else break;
      }

      let waypoint=null;
      if(g.path?.length && g.pathIndex<g.path.length){
        waypoint=worldToCanvas(world,g.path[g.pathIndex][0],g.path[g.pathIndex][1]);
      }else if(pathState && isFloor(targetCell.x,targetCell.y)){
        waypoint=worldToCanvas(world,targetCell.x,targetCell.y);
      }

      let dx=(waypoint?waypoint.x:g.x)-g.x;
      let dy=(waypoint?waypoint.y:g.y)-g.y;
      const moveSpeed=(g.patrolSpeed||defaultGuardSpeed);
      const dm=Math.hypot(dx,dy);
      const moveStartX=g.x, moveStartY=g.y;

      if(dm>0.35){
        const ux=dx/dm, uy=dy/dm;
        const total=moveSpeed*dt;
        const totalX=ux*total, totalY=uy*total;
        const subSteps=Math.max(1,Math.ceil(Math.hypot(totalX,totalY)/MAX_MOVE_STEP));
        const sx=totalX/subSteps, sy=totalY/subSteps;
        let movedAny=false;
        for(let i=0;i<subSteps;i++){
          const fullX=g.x+sx, fullY=g.y+sy;
          if(canGuardStandAt(fullX,fullY,g.radius)){
            g.x=fullX; g.y=fullY; movedAny=true; continue;
          }
          const canX=canGuardStandAt(fullX,g.y,g.radius);
          const canY=canGuardStandAt(g.x,fullY,g.radius);
          if(canX){g.x=fullX;movedAny=true;}
          if(canY){g.y=fullY;movedAny=true;}
          if(!canX && !canY) break;
        }
        // Velocity reflects the intended motion, not a collision response. This keeps
        // animation/heading continuous and lets the stall detector decide when a true
        // blockage occurred instead of creating a visible zero-speed pause.
        g.vx=ux*moveSpeed; g.vy=uy*moveSpeed;
        g.faceDir.x=ux; g.faceDir.y=uy;
        g.lastMovementSucceeded=!!movedAny;
      }else{
        g.vx=0; g.vy=0;
        if(g.state==='PATROL'){
          g.patrolRouteIndex=g.patrolRoute?.length||0;
          g.patrolCooldown=Math.min(g.patrolCooldown,0);
        }
      }

      // ROOT CAUSE FIX: detect lack of actual world-space progress, not merely a
      // blocked-path flag. This catches corner-snags, stale waypoints, diagonal
      // collisions, and two-agent interference even when the grid path itself is valid.
      const moved=Math.hypot(g.x-moveStartX,g.y-moveStartY);
      const wantedDistance=Math.max(0,dm);
      if(wantedDistance>1.5 && moved<0.20){
        g.stuckTime=(g.stuckTime||0)+dt;
      }else{
        g.stuckTime=Math.max(0,(g.stuckTime||0)-dt*2.5);
      }
      g.stuckCooldown=Math.max(0,(g.stuckCooldown||0)-dt);

      if(g.stuckTime>0.06 && g.stuckCooldown<=0){
        g.stuckCooldown=0.08;
        g.blockedFrames=(g.blockedFrames||0)+1;
        const actualCell=canvasToGrid(g.x,g.y);
        const goalCell=targetCell;
        // Repath from the guard's REAL cell immediately; never keep walking against
        // a stale waypoint after collision has invalidated it.
        const retry=findGridPath(actualCell,goalCell);
        if(retry.length>1){
          g.path=retry;
          g.pathIndex=1;
          g.pathTarget={x:goalCell.x,y:goalCell.y};
          g.pathTimer=0.04;
          g.detourCell=null;
        }else{
          const detour=pickGuardEscapeCell(g,goalCell) || pickGuardDetour(g,goalCell);
          if(detour){
            g.path=[actualCell,detour];
            g.pathIndex=1;
            g.pathTarget={x:goalCell.x,y:goalCell.y};
            g.pathTimer=0.04;
            g.detourCell=detour.slice();
          }
        }
        // Do not zero velocity here: the next fixed step should immediately use the new path.
      }

      // If the guard has made effectively no progress for a sustained interval,
      // relocate only to the nearest legal floor center. This is a last-resort
      // recovery from numerical/corner deadlocks, not a teleport toward the player.
      if(g.stuckTime>0.42){
        const actual=canvasToGrid(g.x,g.y);
        let safe=pickGuardEscapeCell(g,targetCell);
        if(!safe) safe=nearestSafeFloorCell(g);
        // Prefer an actual adjacent escape cell when possible. Snapping to the same
        // cell is not recovery; it would simply restart the same deadlock.
        if(safe && (safe[0]!==actual.x || safe[1]!==actual.y)){
          const pos=worldToCanvas(world,safe[0],safe[1]);
          g.x=pos.x; g.y=pos.y; g.cell=safe.slice();
        }else{
          // Final bounded BFS recovery: find the nearest legal neighboring cell,
          // regardless of whether it moves toward the current target. This breaks
          // local corner/doorway deadlocks deterministically without teleporting
          // across the map.
          const q=[[actual.x,actual.y]],seen=new Set([actual.x+','+actual.y]);
          let recovery=null;
          for(let qi=0;qi<q.length && qi<20;qi++){
            const [cx,cy]=q[qi];
            for(const [dx2,dy2] of [[1,0],[-1,0],[0,1],[0,-1]]){
              const nx=cx+dx2,ny=cy+dy2,key=nx+','+ny;
              if(seen.has(key)||!isFloor(nx,ny))continue;
              seen.add(key);q.push([nx,ny]);
              const pos=worldToCanvas(world,nx,ny);
              if(canGuardStandAt(pos.x,pos.y,g.radius)){recovery=[nx,ny];break;}
            }
            if(recovery)break;
          }
          if(recovery){
            const pos=worldToCanvas(world,recovery[0],recovery[1]);
            g.x=pos.x; g.y=pos.y; g.cell=recovery.slice();
          }
        }
        g.path=[]; g.pathIndex=0; g.pathTimer=0; g.pathTarget=null;
        g.patrolRoute=null; g.patrolRouteIndex=0;
        g.detourCell=null;
        g.stuckTime=0;
        g.blockedFrames=0;
      }

      if(!canGuardStandAt(g.x,g.y,g.radius)){
        const safe=nearestSafeFloorCell(g);
        if(safe){const pos=worldToCanvas(world,safe[0],safe[1]);g.x=pos.x;g.y=pos.y;g.cell=safe.slice();g.vx=0;g.vy=0;g.path=[];g.pathIndex=0;g.pathTimer=0;}
      }

      const cg=canvasToGrid(g.x,g.y);
      if(isFloor(cg.x,cg.y)) g.cell=[cg.x,cg.y];
      if(g.state==='CHASE'||g.state==='SEARCH'||g.state==='DISTRACT'||d<=SENSE_R) anyChase=true;

      g.stepTimer=(g.stepTimer||0)-dt;
      if(g.stepTimer<=0){
        g.stepTimer=.42;
        g.pulse=1;
        if(g.state!=='PATROL'||d<300)playSfx('step');
      }
      g.pulse=Math.max(0,(g.pulse||0)-dt*1.15);

      if(dist(g,p)<=CAPTURE_R){fail('تم القبض عليك! رجال الأمن أمسكوا بك.');return;}
    }
    world.anyChase=anyChase;
  }

  function nearestSafeFloorCell(g){
    const start=canvasToGrid(g.x,g.y);
    if(isFloor(start.x,start.y)){
      const pos=worldToCanvas(world,start.x,start.y);
      if(canGuardStandAt(pos.x,pos.y,g.radius)) return [start.x,start.y];
    }
    const q=[[start.x,start.y]],seen=new Set([start.x+','+start.y]);
    for(let i=0;i<q.length;i++){
      const [x,y]=q[i];
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nx=x+dx,ny=y+dy,key=nx+','+ny;
        if(seen.has(key)||!isFloor(nx,ny))continue;
        seen.add(key);q.push([nx,ny]);
        const pos=worldToCanvas(world,nx,ny);
        if(canGuardStandAt(pos.x,pos.y,g.radius))return [nx,ny];
      }
    }
    return null;
  }

  // Robust grid pathfinder. Accepts either {x,y} objects or [x,y] tuples,
  // but internally uses one representation only. This prevents the old
  // object/array mismatch that silently reduced chase paths to length 1.
  function findGridPath(start, target){
    const s=Array.isArray(start)?[start[0],start[1]]:[start?.x,start?.y];
    const t=Array.isArray(target)?[target[0],target[1]]:[target?.x,target?.y];
    if(!Number.isInteger(s[0]) || !Number.isInteger(s[1]) || !Number.isInteger(t[0]) || !Number.isInteger(t[1])) return [];
    if(!isFloor(s[0],s[1]) || !isFloor(t[0],t[1])) return [];
    if(s[0]===t[0] && s[1]===t[1]) return [[s[0],s[1]]];

    const q=[[s[0],s[1]]];
    const prev=new Map([[s[0]+','+s[1],null]]);
    const dirs=[[1,0],[-1,0],[0,1],[0,-1]];

    for(let i=0;i<q.length;i++){
      const [x,y]=q[i];
      if(x===t[0] && y===t[1]) break;
      for(const [dx,dy] of dirs){
        const nx=x+dx, ny=y+dy;
        const key=nx+','+ny;
        if(!isFloor(nx,ny) || prev.has(key)) continue;
        prev.set(key,[x,y]);
        q.push([nx,ny]);
      }
    }

    const targetKey=t[0]+','+t[1];
    if(!prev.has(targetKey)) return [];

    const path=[];
    let cur=[t[0],t[1]];
    while(cur){
      path.push(cur);
      cur=prev.get(cur[0]+','+cur[1]) || null;
    }
    path.reverse();
    return path;
  }

  function updateSecurityCameras(dt,now,playerSpeed){
    if(!world.cameras?.length)return;
    const p=world.player; const nowSec=now/1000;
    for(const cam of world.cameras){
      cam.angle+=cam.sweep*dt*(0.42+level.level*0.028);
      cam.angle=Math.atan2(Math.sin(cam.angle),Math.cos(cam.angle));
      const dx=p.x-cam.x,dy=p.y-cam.y,d=Math.hypot(dx,dy);
      const RANGE=150;
      const HALF_ANGLE=0.25;
      if(d>RANGE){
        cam.trigger=Math.max(0,(cam.trigger||0)-dt*4);
        continue;
      }
      const target=Math.atan2(dy,dx);
      const diff=Math.abs(Math.atan2(Math.sin(target-cam.angle),Math.cos(target-cam.angle)));
      // Add the player's angular radius so a camera does not miss because its cone
      // passes across the edge of the character between simulation steps.
      const bodyAngle=d>1?Math.asin(Math.min(.45,(p.r||8)/d)):.45;
      const inCone=diff<(HALF_ANGLE+bodyAngle);
      // A camera can only report the player when the entire sight ray is clear.
      // Any wall cell between camera and player blocks detection, regardless of range.
      const clear=inCone && hasLineOfSight(cam,p);
      if(clear){
        const firstDetection=!cam.trigger;
        cam.trigger=1;
        world.alarmUntil=Math.max(world.alarmUntil||0,nowSec+6);
        world.alarmTarget={x:p.x,y:p.y};
        if(!world.radarPulses.some(r=>Math.abs(r.x-cam.x)<1&&Math.abs(r.y-cam.y)<1&&r.life>.5)) world.radarPulses.push({x:cam.x,y:cam.y,r:12,max:176,life:.75});
        if(firstDetection){showMessage('🚨 الكاميرا رصدتك! الشرطة تطاردك!');playSfx('alarm');}
      }else{
        cam.trigger=Math.max(0,(cam.trigger||0)-dt*5);
      }
    }
  }

  // Kept as a safe fallback for any older call site. It is intentionally random
  // over the whole connected floor set and never reads the player.
  function choosePatrolCell(base){
    const pool=world?.floorCells?.length?world.floorCells: [base];
    return pool[Math.floor(world.rng.next()*pool.length)] || base;
  }
  function collideEntityWalls(x,y,r,g){
    const g1=canvasToGrid(x-r,y),g2=canvasToGrid(x+r,y),g3=canvasToGrid(x,y-r),g4=canvasToGrid(x,y+r);
    if([g1,g2,g3,g4].some(q=>!isFloor(q.x,q.y))) return {x:g.x,y:g.y}; return {x,y};
  }
  function hasLineOfSight(a,b){
    const steps=Math.ceil(dist(a,b)/8);for(let i=1;i<steps;i++){const t=i/steps;const x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t,g=canvasToGrid(x,y);if(!isFloor(g.x,g.y))return false;}return true;
  }
  function collectNearbyWalls(){
    const p=world.player, out=[]; const r=170; const minX=Math.max(0,Math.floor((p.x-r-world.ox)/world.cell)),maxX=Math.min(world.cols-1,Math.ceil((p.x+r-world.ox)/world.cell));
    const minY=Math.max(0,Math.floor((p.y-r-world.oy)/world.cell)),maxY=Math.min(world.rows-1,Math.ceil((p.y+r-world.oy)/world.cell));
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)if(world.grid[y][x]===1)out.push({x:world.ox+x*world.cell,y:world.oy+y*world.cell,w:world.cell,h:world.cell});
    return out;
  }

  function updateHazardsAndDoors(dt,speed){
    const p=world.player;
    world.hazards.forEach(h=>{h.cool=Math.max(0,h.cool-dt);if(h.cool<=0&&dist(p,h)<h.r+7&&Math.hypot(p.vx,p.vy)>10){h.cool=1.25;world.radarPulses.push({x:h.x,y:h.y,r:8,max:105,life:1.0});playSfx('glass');showMessage('زجاج مكسور! الحراس تلقّوا الإنذار');}});
    world.doors.forEach(d=>{const near=Math.abs(p.x-d.x)<28&&Math.abs(p.y-d.y)<28;const target=near&&speed>105?1:0;d.open += (target-d.open)*Math.min(1,dt*5);});
  }
  function updateTimer(dt){
    if(!world.timerRunning || isGameOver) return;
    world.timer=Math.max(0,world.timer-dt);
    if(world.timer<=0&&!world.lockdown){
      world.timer=0; world.lockdown=true; canvas.classList.add('lockdown'); playSfx('lockdown');
      showMessage('انتهى الوقت! تم تفعيل إغلاق البنك.');
      world.guards.forEach(g=>{g.state='CHASE';g.lastKnown={...world.player};g.target={...world.player};g.vx*=2;g.vy*=2;});
    }
  }
  function checkFailureAndSuccess(){
    if(world.lockdown){fail('انتهى الوقت — تم تفعيل الإغلاق الأحمر');return;}
    if(world.escapeArmed&&dist(world.player,world.escape)<20){succeed();}
  }
  function fail(msg){
    if(!isMapFullyLoaded||isGameOver)return;
    isGameOver=true;
    showMessage(msg);
    canvas.classList.remove('lockdown');
    setState('FAILURE');
    startResultRain('cuffs');
    fadeGameOverMusicIn();
  }
  function succeed(){
    if(!isMapFullyLoaded||isGameOver)return;
    stopResultMusicNow();
    isGameOver=true;
    playSfx('success');
    playSfx('escape');
    try{
      if(audio?.ac?.state==='running' && music.finalGain){
        music.finalGain.gain.cancelScheduledValues(audio.ac.currentTime);
        music.finalGain.gain.setTargetAtTime(0,audio.ac.currentTime,.70);
      }
    }catch(_){}
    markRoundCompleted(level.stage,level.level);
    setState('SUCCESS');
    startResultRain('money');
    fadeResultMusicIn();
  }

  function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
  function draw(now){
    ctx.setTransform(RENDER_SCALE,0,0,RENDER_SCALE,0,0);ctx.fillStyle='#000';ctx.fillRect(0,0,W,H);
    if(gameState!=='PLAYING'||!world||!isMapFullyLoaded)return;
    drawWorld(now); drawLighting(now); drawHUDEffects(now);
  }
  function buildBackgroundLayer(w){
    const layer=document.createElement('canvas'); layer.width=W; layer.height=H;
    const cctx=layer.getContext('2d'); const c=w.cell, bw=w.cols*c, bh=w.rows*c;
    cctx.fillStyle='#111417'; cctx.fillRect(0,0,W,H);
    const floorGrad=cctx.createLinearGradient(w.ox,w.oy,w.ox+bw,w.oy+bh);
    floorGrad.addColorStop(0,'#72767d'); floorGrad.addColorStop(.22,'#5f646c'); floorGrad.addColorStop(.48,'#4a5057'); floorGrad.addColorStop(.72,'#363c43'); floorGrad.addColorStop(1,'#242a31');
    cctx.fillStyle=floorGrad; cctx.fillRect(w.ox,w.oy,bw,bh);
    for(let y=0;y<w.rows;y++) for(let x=0;x<w.cols;x++) if(w.grid[y][x]===0){
      const fx=w.ox+x*c,fy=w.oy+y*c,tone=((x*17+y*31+w.seed)>>>0)%7,shade=104+tone*4;
      const warm=0.014+tone*.003;
      cctx.fillStyle=`rgba(241,221,176,${warm})`; cctx.fillRect(fx+1,fy+1,c-2,c-2);
      cctx.strokeStyle='rgba(12,18,24,.42)'; cctx.lineWidth=.8; cctx.strokeRect(fx+.4,fy+.4,c-.8,c-.8);
      cctx.fillStyle='rgba(180,197,211,.035)';
      for(let q=0;q<2;q++){const nx=fx+((tone*13+q*11)%Math.max(2,c-2))+1,ny=fy+((tone*5+q*7)%Math.max(2,c-2))+1;cctx.fillRect(nx,ny,1,1);}
    }
    for(let y=0;y<w.rows;y++) for(let x=0;x<w.cols;x++) if(w.grid[y][x]===1){
      const wx=w.ox+x*c,wy=w.oy+y*c;
      cctx.fillStyle='rgba(0,0,0,.26)';cctx.fillRect(wx+2,wy+3,c+2,c+2);
      cctx.fillStyle='#eee9df';cctx.fillRect(wx,wy,c,c);
      cctx.fillStyle='#d9cfbf';cctx.fillRect(wx+1,wy+c-5,c-2,4);
      cctx.fillStyle='#f7f4ee';cctx.fillRect(wx+1,wy+1,c-2,3);
      cctx.strokeStyle='rgba(86,102,113,.28)';cctx.lineWidth=1;cctx.strokeRect(wx+.5,wy+.5,c-1,c-1);
      if(y===0||w.grid[y-1]?.[x]===0){cctx.fillStyle='rgba(188,147,74,.18)';cctx.fillRect(wx,wy,c,2);}
    }
    // Bank teller counter / queue furniture.
    const hallX=w.ox+c*1.4, hallY=w.oy+c*(w.rows-3.0);
    cctx.save(); cctx.shadowColor='rgba(0,0,0,.24)';cctx.shadowBlur=10;
    cctx.fillStyle='#4b3a2b';cctx.fillRect(hallX,hallY,c*6.4,c*.72);cctx.shadowBlur=0;
    cctx.fillStyle='#b18a50';cctx.fillRect(hallX,hallY-5,c*6.4,6);
    cctx.fillStyle='#eee7dc'; for(let i=0;i<4;i++){const bx=hallX+c*.25+i*c*1.45;cctx.fillRect(bx,hallY+c*.12,c*1.05,2);cctx.fillStyle='#c5b8a6';cctx.fillRect(bx,hallY+c*.28,c*1.05,2);cctx.fillStyle='#eee7dc';}
    cctx.fillStyle='#232d36';cctx.fillRect(hallX+c*.1,hallY+c*.76,c*6.2,c*.08);
    cctx.fillStyle='#bca97f';cctx.font=`700 ${Math.max(8,c*.30)}px Cairo,sans-serif`;cctx.textAlign='center';cctx.fillText('البنك',hallX+c*3.2,hallY+c*.55);cctx.restore();
    for(let y=1;y<w.rows-1;y++) for(let x=1;x<w.cols-1;x++){
      if(w.grid[y][x]!==0) continue; const n=((x*73856093)^(y*19349663)^w.seed)>>>0,wx=w.ox+x*c,wy=w.oy+y*c;
      if(n%113===0){cctx.save();cctx.translate(wx+c*.5,wy+c*.5);cctx.fillStyle='#72553f';cctx.fillRect(-c*.34,-c*.16,c*.68,c*.32);cctx.fillStyle='#ddd4c7';cctx.fillRect(-c*.29,-c*.13,c*.58,c*.05);cctx.fillStyle='#292622';cctx.fillRect(-c*.08,-c*.04,c*.16,c*.16);cctx.fillStyle='#b8ab99';cctx.fillRect(-c*.52,c*.18,c*.08,c*.20);cctx.fillRect(c*.44,c*.18,c*.08,c*.20);cctx.restore();}
      else if(n%157===0){cctx.save();cctx.translate(wx+c*.5,wy+c*.5);cctx.fillStyle='#675343';cctx.fillRect(-c*.13,c*.10,c*.26,c*.18);cctx.fillStyle='#476349';for(let a=0;a<6;a++){const ang=a*Math.PI/3;cctx.beginPath();cctx.ellipse(Math.cos(ang)*c*.16,Math.sin(ang)*c*.12,c*.16,c*.06,ang,0,Math.PI*2);cctx.fill();}cctx.restore();}
      else if(n%173===0){cctx.save();cctx.translate(wx+c*.5,wy+c*.5);cctx.fillStyle='#77716a';cctx.fillRect(-2,-c*.18,4,c*.36);cctx.beginPath();cctx.arc(0,-c*.19,3,0,Math.PI*2);cctx.fill();cctx.restore();}
    }
    for(let y=1;y<w.rows-1;y+=3) for(let x=1;x<w.cols-1;x+=4){if(!isFloorFor(w,x,y))continue;const wx=w.ox+x*c+c*.5,wy=w.oy+y*c+c*.5;cctx.save();cctx.globalAlpha=.12;cctx.fillStyle='#fff5da';cctx.beginPath();cctx.ellipse(wx,wy,Math.min(22,c*.85),Math.min(10,c*.42),0,0,Math.PI*2);cctx.fill();cctx.restore();}
    cctx.save();const sx=w.ox+12,sy=w.oy+12;cctx.fillStyle='rgba(238,232,219,.95)';cctx.strokeStyle='rgba(92,80,67,.4)';cctx.fillRect(sx,sy,145,30);cctx.strokeRect(sx+.5,sy+.5,144,29);cctx.fillStyle='#574d45';cctx.font='700 11px Cairo,sans-serif';cctx.fillText('فرع البنك المركزي',sx+10,sy+19);cctx.restore();
    return layer;
  }
  function isFloorFor(w,gx,gy){return gx>=0&&gy>=0&&gx<w.cols&&gy<w.rows&&w.grid[gy][gx]===0;}
  function drawWorld(now){
    if(!world.backgroundCanvas) world.backgroundCanvas=buildBackgroundLayer(world);
    ctx.drawImage(world.backgroundCanvas,0,0);
    drawBankDecor();
    drawKeys(); drawVault(); drawEscape(); drawHazards(); drawDoors(); drawGuards(); drawPlayer(now);
  }

  function drawBankDecor(){
    const CAMERA_RANGE=150;
    const CAMERA_HALF_ANGLE=0.25;
    world.cameras?.forEach(cam=>{
      ctx.save();ctx.translate(cam.x,cam.y);
      ctx.fillStyle='#a9a39a';ctx.strokeStyle=cam.trigger>0?'#d5222d':'#4f5660';ctx.lineWidth=1.3;
      ctx.beginPath();ctx.arc(0,0,6,0,Math.PI*2);ctx.fill();ctx.stroke();
      ctx.rotate(cam.angle);
      const edgeX=Math.cos(CAMERA_HALF_ANGLE)*CAMERA_RANGE;
      const edgeY=Math.sin(CAMERA_HALF_ANGLE)*CAMERA_RANGE;
      ctx.fillStyle=cam.trigger>0?'rgba(220,30,38,.22)':'rgba(219,203,157,.075)';
      ctx.beginPath();ctx.moveTo(5,-2);ctx.lineTo(edgeX,-edgeY);ctx.quadraticCurveTo(CAMERA_RANGE+10,0,edgeX,edgeY);ctx.lineTo(5,2);ctx.closePath();ctx.fill();
      ctx.strokeStyle=cam.trigger>0?'rgba(230,45,55,.38)':'rgba(212,184,120,.18)';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(5,0);ctx.lineTo(edgeX,-edgeY);ctx.moveTo(5,0);ctx.lineTo(edgeX,edgeY);ctx.stroke();
      ctx.fillStyle=cam.trigger>0?'#f2444f':'#55616d';ctx.fillRect(2,-3,8,6);
      ctx.restore();
    });
  }

  function drawKeys(){
    world.keys.forEach((k,i)=>{if(k.collected)return;ctx.save();ctx.translate(k.x,k.y);
      const bob=Math.sin(performance.now()*.004+i)*1.5;ctx.translate(0,bob);ctx.rotate(-.08);
      ctx.shadowBlur=14;ctx.shadowColor='#f0c96c';ctx.strokeStyle='#a66b28';ctx.fillStyle='#d7a84b';ctx.lineWidth=1.4;
      ctx.beginPath();ctx.arc(-6,0,6,0,Math.PI*2);ctx.fill();ctx.stroke();
      ctx.fillStyle='#8b5a24';ctx.beginPath();ctx.arc(-6,0,2.6,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#d9ad55';ctx.fillRect(0,-2,15,4);ctx.fillRect(9,-2,3,7);ctx.fillRect(13,-2,3,5);
      ctx.strokeStyle='rgba(255,247,205,.75)';ctx.beginPath();ctx.arc(-8,-2,1.5,0,Math.PI*2);ctx.stroke();ctx.restore();
    });
  }

  function drawVault(){
    const v=world.vault;ctx.save();ctx.translate(v.x,v.y);
    // A bank vault door: thick steel frame, hinges, wheel, bolts and warning plaque.
    ctx.shadowColor='rgba(0,0,0,.45)';ctx.shadowBlur=18;
    ctx.fillStyle='#77736b';ctx.fillRect(-30,-34,60,68);ctx.shadowBlur=0;
    ctx.fillStyle='#b6b2aa';ctx.fillRect(-25,-29,50,58);
    ctx.fillStyle='#6f6c66';ctx.fillRect(-21,-25,42,50);
    ctx.strokeStyle='#d2cec5';ctx.lineWidth=2;ctx.strokeRect(-18,-22,36,44);
    ctx.fillStyle='#3b3936';ctx.beginPath();ctx.arc(0,0,12,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='#d4cfc2';ctx.lineWidth=2;for(let a=0;a<Math.PI*2;a+=Math.PI/6){ctx.beginPath();ctx.moveTo(Math.cos(a)*4,Math.sin(a)*4);ctx.lineTo(Math.cos(a)*11,Math.sin(a)*11);ctx.stroke();}
    ctx.fillStyle='#c9c0ad';ctx.fillRect(-4,-18,8,36);
    ctx.fillStyle=world.vaultOpen?'#4e9b60':'#9c352f';ctx.beginPath();ctx.arc(19,-19,3,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#f2e6cf';ctx.font='700 9px Cairo,sans-serif';ctx.textAlign='center';ctx.fillText('الخزنة',0,43);ctx.restore();
  }

  function drawEscape(){
    const e=world.escape;ctx.save();ctx.translate(e.x,e.y);
    ctx.fillStyle='#eee9df';ctx.strokeStyle=world.escapeArmed?'#356d43':'#5b574f';ctx.lineWidth=2;ctx.fillRect(-16,-24,32,48);ctx.strokeRect(-16,-24,32,48);
    ctx.fillStyle='#4f6d86';ctx.fillRect(-8,-15,16,30);ctx.fillStyle='#f6f0e4';ctx.fillRect(-2,0,6,2);
    ctx.fillStyle=world.escapeArmed?'#2d7b46':'#9b9488';ctx.font='700 8px Cairo,sans-serif';ctx.textAlign='center';ctx.fillText('مخرج',0,-28);ctx.restore();
  }

  function drawHazards(){world.hazards.forEach(h=>{ctx.save();ctx.translate(h.x,h.y);ctx.rotate(-.2);
    ctx.fillStyle='rgba(235,235,225,.72)';ctx.strokeStyle='rgba(80,74,65,.45)';ctx.lineWidth=1;
    for(let i=0;i<3;i++){ctx.beginPath();ctx.moveTo(-7+i*5,5);ctx.lineTo(-4+i*4,-6-i);ctx.lineTo(1+i*4,4);ctx.closePath();ctx.fill();ctx.stroke();}
    ctx.restore();})}

  function drawDoors(){world.doors.forEach(d=>{ctx.save();ctx.translate(d.x,d.y);ctx.globalAlpha=.35+.65*d.open;
    ctx.fillStyle='#b1aaa0';ctx.strokeStyle='#5d584f';ctx.lineWidth=1.2;
    if(d.orient==='h'){ctx.fillRect(-20,-5,40,10);ctx.strokeRect(-20.5,-5.5,41,11);}
    else{ctx.fillRect(-5,-20,10,40);ctx.strokeRect(-5.5,-20.5,11,41);}
    ctx.fillStyle='#d8d2c8';ctx.fillRect(-2,-2,4,4);ctx.restore();})}

  function drawLighting(now){
    const p=world.player;

    // Stable lighting model: do NOT blend the scene with destination-in or a
    // full-canvas transparent gradient. Instead, draw an opaque black mask
    // and carve a real geometric hole around the burglar using the even-odd
    // fill rule. This works reliably on opaque Canvas 2D contexts as well.
    const radius = Math.max(0, Math.min(190, world.lightRadius ?? 190));

    ctx.save();
    ctx.fillStyle = '#000';

    if(radius > 1){
      ctx.beginPath();
      ctx.rect(0,0,W,H);
      ctx.arc(p.x,p.y,radius,0,Math.PI*2,true);
      // Full canvas minus the circular hole = black outside, visible inside.
      ctx.fill('evenodd');

      // Soft dark falloff around the edge. These are normal translucent rings
      // drawn inside the already-open hole; they cannot cover the centre.
      const rings = [
        {r:radius, a:.55},
        {r:radius*.90, a:.32},
        {r:radius*.80, a:.16}
      ];
      for(const ring of rings){
        const rg=ctx.createRadialGradient(p.x,p.y,Math.max(1,ring.r*.72),p.x,p.y,ring.r);
        rg.addColorStop(0,'rgba(0,0,0,0)');
        rg.addColorStop(1,`rgba(0,0,0,${ring.a})`);
        ctx.fillStyle=rg;
        ctx.beginPath();
        ctx.arc(p.x,p.y,ring.r,0,Math.PI*2);
        ctx.fill();
      }
      // Feathered edge: a thin, animated dusk ring makes the light contract/expand softly.
      const feather=ctx.createRadialGradient(p.x,p.y,Math.max(1,radius*.72),p.x,p.y,radius*1.06);
      feather.addColorStop(0,'rgba(0,0,0,0)');
      feather.addColorStop(.78,'rgba(0,0,0,.08)');
      feather.addColorStop(1,'rgba(0,0,0,.22)');
      ctx.fillStyle=feather;
      ctx.beginPath();
      ctx.arc(p.x,p.y,radius*1.06,0,Math.PI*2);
      ctx.fill();
    }else{
      ctx.fillRect(0,0,W,H);
    }
    ctx.restore();

    // Radar pulses are intentionally visible through the darkness.
    world.radarPulses=world.radarPulses.filter(pu=>{
      pu.life-=1/60;
      pu.r+=4;
      return pu.life>0&&pu.r<pu.max;
    });
    world.radarPulses.forEach(pu=>{
      ctx.save();
      ctx.globalAlpha=Math.max(0,pu.life*.30);
      ctx.strokeStyle=pu.life>.7?'#f5f1dc':'#d9d9d9';
      ctx.lineWidth=2;
      ctx.beginPath();
      ctx.arc(pu.x,pu.y,pu.r,0,Math.PI*2);
      ctx.stroke();
      ctx.restore();
    });

    // The burglar is always visible, especially after the light fully decays.
    drawPlayer(now,true);
  }

  function drawHUDEffects(){
    if(world.explosionFlash>0){ctx.save();ctx.fillStyle=`rgba(220,30,35,${world.explosionFlash})`;ctx.fillRect(0,0,W,H);ctx.restore();}
    ctx.save();ctx.font='12px "Share Tech Mono"';ctx.fillStyle='rgba(65,50,40,.82)';ctx.fillText(world.escapeArmed?'الخزنة مؤمّنة — اذهب إلى المخرج':'اجمع 3 مفاتيح',20,H-20);ctx.restore();
  }

  function drawPlayer(now,ghostOverlay=false){
    drawPlayerVisual(ctx, world.player, now, ghostOverlay, !!world.vaultOpened);
  }

  function drawPlayerVisual(target,p,now,ghostOverlay=false,hasLoot=false){
    const speed=Math.hypot(p.vx||0,p.vy||0), bob=(p.wobble||0)*Math.sin(now*.012)*.08, sx=1+bob, sy=1-bob;
    target.save();target.translate(p.x,p.y);target.scale(sx,sy);target.globalAlpha=ghostOverlay?1:1;
    target.fillStyle='rgba(0,0,0,.65)';target.beginPath();target.ellipse(0,18,15,5,0,0,Math.PI*2);target.fill();
    target.fillStyle='#111';target.beginPath();target.roundRect(-11,-1,22,24,6);target.fill();
    target.fillStyle='#1b1b1b';target.fillRect(-15,2,6,12);target.fillRect(9,2,6,12);
    target.fillStyle='#090909';target.fillRect(-7,9,5,11);target.fillRect(2,9,5,11);
    target.save();target.translate(-12,2);target.rotate(-.15);target.fillStyle='#3a2a1e';target.beginPath();target.roundRect(-4,-2,12,15,3);target.fill();target.strokeStyle='#8a6745';target.lineWidth=1;target.stroke();target.fillStyle='#8a6745';target.fillRect(-1,0,6,1);target.restore();
    if(hasLoot){
      const carryBob=Math.sin(now*.010)*1.5;
      target.save();target.translate(15,8+carryBob);target.rotate(.08);
      target.fillStyle='#80542a';target.beginPath();target.moveTo(-7,-2);target.quadraticCurveTo(-10,8,0,14);target.quadraticCurveTo(10,8,7,-2);target.quadraticCurveTo(0,-6,-7,-2);target.fill();
      target.fillStyle='#d1a84f';target.fillRect(-7,-4,14,4);target.fillStyle='#e5c76e';target.beginPath();target.arc(0,0,2.2,0,Math.PI*2);target.fill();
      target.fillStyle='#111';target.font='bold 9px sans-serif';target.textAlign='center';target.fillText('$',0,8);target.restore();
    }
    target.fillStyle='#090909';target.beginPath();target.arc(0,-9,11,Math.PI,Math.PI*2);target.fill();
    const d=p.lastDir||{x:1,y:0}, dm=Math.hypot(d.x,d.y)||1, ux=d.x/dm,uy=d.y/dm,px=-uy,py=ux,rot=Math.atan2(uy,ux);
    target.fillStyle='#020202';target.beginPath();target.ellipse(ux*2.5,uy*2.5,10.5,6.8,rot,0,Math.PI*2);target.fill();
    target.fillStyle='#171717';target.fillRect(ux*6-8,uy*6-1.5,16,3);
    // Angry eyes: angled whites with dark pupils, not the old sleepy cyan slits.
    for(const side of [-1,1]){
      const ex=ux*6+px*3.1*side, ey=uy*6+py*3.1*side;
      target.fillStyle='#f6f0de';target.beginPath();
      target.moveTo(ex-px*2.6,ey-py*1.0);
      target.lineTo(ex+px*2.4+ux*1.2,ey+py*2.0+uy*1.2);
      target.lineTo(ex+px*2.2,ey+py*0.9);
      target.lineTo(ex-px*2.2+ux*1.1,ey-py*1.7+uy*1.1);target.closePath();target.fill();
      target.fillStyle='#161616';target.beginPath();target.arc(ex+ux*.7,ey+uy*.7,1.45,0,Math.PI*2);target.fill();
      target.strokeStyle='#000';target.lineWidth=1.8;target.beginPath();
      target.moveTo(ex-px*2.4+ux*1.3,ey-py*2.1+uy*1.3);target.lineTo(ex+px*2.3-ux*.8,ey+py*2.0-uy*.8);target.stroke();
    }
    target.strokeStyle='#6c6964';target.lineWidth=2;target.beginPath();target.moveTo(ux*12+px*9,uy*12+py*9);target.lineTo(ux*23+px*9,uy*23+py*9);target.stroke();
    target.restore();
  }

  function drawGuards(){
    world.guards.forEach(g=>drawGuardVisual(ctx,g));
  }

  function drawGuardVisual(target,g,menuStatic=false){
    const chasing=g.state==='CHASE'||g.state==='SEARCH'||g.state==='DISTRACT';
    const dangerR=chasing?146:122;
    if(!menuStatic){
      target.save();target.globalAlpha=chasing?.30:.22;target.strokeStyle=chasing?'#c92b32':'#a72d35';target.lineWidth=2.2;target.shadowBlur=chasing?18:10;target.shadowColor='#d02c35';
      target.setLineDash(chasing?[10,6]:[5,8]);target.beginPath();target.arc(g.x,g.y,dangerR,0,Math.PI*2);target.stroke();target.setLineDash([]);
      if(chasing){target.globalAlpha=.055;target.fillStyle='#d02c32';target.beginPath();target.arc(g.x,g.y,dangerR,0,Math.PI*2);target.fill();}
      if(g.pulse>0&&!world.lastPlayerMoving){target.globalAlpha=g.pulse*.55;target.strokeStyle='#efe8d6';target.lineWidth=1.5;target.beginPath();target.arc(g.x,g.y,18+g.pulse*92,0,Math.PI*2);target.stroke();}
      target.restore();
    }
    target.globalAlpha=1;target.save();target.translate(g.x,g.y);
    const fd=g.faceDir||{x:1,y:0}, dm=Math.hypot(fd.x,fd.y)||1,ux=fd.x/dm,uy=fd.y/dm,px=-uy,py=ux,rot=Math.atan2(uy,ux);
    target.fillStyle='rgba(0,0,0,.34)';target.beginPath();target.ellipse(0,18,15,5,0,0,Math.PI*2);target.fill();
    target.fillStyle='#1c2d3d';target.beginPath();target.roundRect(-13,-2,26,24,6);target.fill();
    target.fillStyle='#f1eee5';target.fillRect(-4,3,8,11);
    target.fillStyle='#33485a';target.fillRect(-18,2,6,16);target.fillRect(12,2,6,16);
    target.fillStyle='#2b2b2b';target.fillRect(-13,15,26,3);target.fillRect(-10,18,6,4);target.fillRect(4,18,6,4);
    target.fillStyle='#c99d7c';target.beginPath();target.arc(0,-9,8.5,0,Math.PI*2);target.fill();
    target.fillStyle='#182735';target.beginPath();target.arc(0,-12,10,Math.PI,Math.PI*2);target.fill();target.fillRect(-12,-12,24,3);
    target.fillStyle='#e5c45d';target.beginPath();target.arc(0,-4,2.8,0,Math.PI*2);target.fill();
    // Angry police eyes that track the current face direction.
    for(const side of [-1,1]){
      const ex=ux*4.9+px*3.0*side, ey=uy*4.9+py*3.0*side;
      target.fillStyle='#f8f4e7';target.beginPath();
      target.moveTo(ex-px*2.0,ey-py*1.0);target.lineTo(ex+px*2.0+ux*1.0,ey+py*1.7+uy*1.0);target.lineTo(ex+px*1.8,ey+py*.6);target.lineTo(ex-px*1.7+ux*.8,ey-py*1.5+uy*.8);target.closePath();target.fill();
      target.fillStyle='#111';target.beginPath();target.arc(ex+ux*.5,ey+uy*.5,1.3,0,Math.PI*2);target.fill();
      target.strokeStyle='#111';target.lineWidth=1.6;target.beginPath();target.moveTo(ex-px*2.1+ux*.8,ey-py*1.8+uy*.8);target.lineTo(ex+px*2.1-ux*.9,ey+py*1.6-uy*.9);target.stroke();
    }
    target.shadowBlur=0;target.strokeStyle='#273d50';target.lineWidth=1.5;target.beginPath();target.moveTo(8,-16);target.lineTo(11,-23);target.stroke();
    target.fillStyle=chasing?'#e63b43':'#d8c5a2';target.beginPath();target.arc(11,-23,1.6,0,Math.PI*2);target.fill();target.restore();
  }

  // V57: prerender exact in-game character drawings once. CSS transform animation then
  // runs on the compositor, so the menu no longer clears/redraws a large canvas every frame.
  let menuActorsReady=false, menuActorsResizeRaf=0;
  function renderMenuActorsOnce(){
    const thief=document.getElementById('menuThiefActor');
    const guard=document.getElementById('menuGuardActor');
    if(!thief||!guard)return;
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const size=620;
    const scale=5.15;
    for(const [canvas,type] of [[thief,'thief'],[guard,'guard']]){
      canvas.width=Math.floor(size*dpr); canvas.height=Math.floor(size*dpr);
      canvas.style.width=size+'px'; canvas.style.height=size+'px';
      const c=canvas.getContext('2d'); c.setTransform(dpr,0,0,dpr,0,0);
      c.clearRect(0,0,size,size); c.save();
      // Render the exact same gameplay character functions, only scaled for the menu.
      c.translate(size/2,type==='thief'?size*.66:size*.64);
      c.scale(scale,scale);
      if(type==='thief'){
        const p={x:0,y:0,vx:0,vy:0,r:9,lastDir:{x:1,y:-.04},wobble:0};
        drawPlayerVisual(c,p,0,false,false);
      }else{
        const g={x:0,y:0,vx:0,vy:0,radius:8,faceDir:{x:-1,y:-.04},state:'PATROL',pulse:0};
        drawGuardVisual(c,g,true);
      }
      c.restore();
    }
    menuActorsReady=true;
  }
  function scheduleMenuActorsRender(){
    if(menuActorsResizeRaf)cancelAnimationFrame(menuActorsResizeRaf);
    menuActorsResizeRaf=requestAnimationFrame(()=>{menuActorsResizeRaf=0;renderMenuActorsOnce();});
  }
  window.addEventListener('resize',scheduleMenuActorsRender,{passive:true});

  function showMessage(text){const el=document.getElementById('messageHud');el.textContent=text;el.style.opacity='1';clearTimeout(showMessage.t);showMessage.t=setTimeout(()=>el.style.opacity='0',2200)}

  // ====== AUDIO ENGINE V26: LIVE, CONTINUOUS BACKGROUND MUSIC ======
  // Music deliberately uses persistent oscillators rather than a large generated
  // AudioBuffer. SFX already prove that the browser's AudioContext works; keeping
  // the BGM on that same context removes file/autoplay/decoding dependencies.
  const music = {
    started:false, ready:false, mode:'ambient', target:'ambient', lastError:'', lastPlayState:'idle',
    finalGain:null, preGain:null, compressor:null, analyser:null, musicBus:null,
    ambientNodes:[], chaseNodes:[], masterLfo:null, masterLfoGain:null,
    ambientLevel:1, chaseLevel:0, signalRms:0, beatTimer:0
  };

  function setAudioStatusSafe(text){
    try { setMusicStatus(text); } catch(_) {
      const el=document.getElementById('audioStatus'); if(el) el.textContent=text;
    }
  }

  function createToneNode(ac, freq, type, level, bus, detune=0){
    const osc=ac.createOscillator();
    const gain=ac.createGain();
    osc.type=type;
    osc.frequency.value=freq;
    osc.detune.value=detune;
    gain.gain.value=level;
    osc.connect(gain).connect(bus);
    osc.start();
    return {osc,gain};
  }

  function ensureMusicGraph(){
    if(!audio||!audio.ac)return false;
    const ac=audio.ac;
    if(music.finalGain)return true;

    music.musicBus=ac.createGain();
    music.musicBus.gain.value=1;

    music.preGain=ac.createGain();
    // Strong internal level so the final BGM cap of 8% is still plainly audible.
    music.preGain.gain.value=3.0;

    music.compressor=ac.createDynamicsCompressor();
    music.compressor.threshold.value=-16;
    music.compressor.knee.value=10;
    music.compressor.ratio.value=6;
    music.compressor.attack.value=.004;
    music.compressor.release.value=.14;

    music.finalGain=ac.createGain();
    music.finalGain.gain.value=isMuted?0:0.08;

    music.analyser=ac.createAnalyser();
    music.analyser.fftSize=1024;
    music.analyser.smoothingTimeConstant=.65;

    music.musicBus.connect(music.preGain);
    music.preGain.connect(music.compressor);
    music.compressor.connect(music.finalGain);
    music.finalGain.connect(music.analyser);
    music.analyser.connect(ac.destination);

    // Slow global breathing modulation, kept deliberately subtle.
    music.masterLfo=ac.createOscillator();
    music.masterLfoGain=ac.createGain();
    music.masterLfo.frequency.value=.075;
    music.masterLfoGain.gain.value=.045;
    music.masterLfo.connect(music.masterLfoGain).connect(music.musicBus.gain);
    music.masterLfo.start();

    return true;
  }

  function buildLiveMusic(){
    if(!ensureMusicGraph()) return false;
    const ac=audio.ac;
    // Do not duplicate persistent sources.
    if(music.ambientNodes.length || music.chaseNodes.length) return true;

    // Ambient: audible mid-range harmony + low bed + soft fifths.
    const ambient=[
      [110,'sine',.20,0],
      [164.81,'triangle',.17,0],
      [220,'sine',.13,0],
      [329.63,'triangle',.085,4],
      [440,'sine',.055,-4]
    ];
    for(const [f,t,g,d] of ambient) music.ambientNodes.push(createToneNode(ac,f,t,g,music.musicBus,d));

    // Chase: brighter, more rhythmic harmonic stack.
    const chase=[
      [123.47,'sawtooth',.14,0],
      [184.99,'triangle',.16,0],
      [246.94,'square',.075,0],
      [369.99,'sawtooth',.065,5],
      [493.88,'triangle',.05,-5]
    ];
    for(const [f,t,g,d] of chase) music.chaseNodes.push(createToneNode(ac,f,t,g,music.musicBus,d));

    // Separate buses are represented by per-node gains so crossfade is explicit.
    // Ambient starts on; chase starts muted.
    for(const n of music.ambientNodes) n.gain.gain.value *= 1;
    for(const n of music.chaseNodes) n.gain.gain.value *= 0;

    music.started=true;
    music.ready=true;
    music.lastPlayState='playing';
    music.target='ambient';
    return true;
  }

  function setNodeGroupLevel(group, level){
    for(const n of group){
      try { n.gain.gain.setTargetAtTime(n.gain.gain.value/Math.max(.0001, level||1), audio.ac.currentTime, .01); } catch(_){}
    }
  }

  function applyMusicMix(ambient, chase){
    // Node base levels are restored through explicit target values.
    const ambientBase=[.20,.17,.13,.085,.055];
    const chaseBase=[.14,.16,.075,.065,.05];
    music.ambientNodes.forEach((n,i)=>n.gain.gain.setTargetAtTime(ambientBase[i]*ambient,audio.ac.currentTime,.05));
    music.chaseNodes.forEach((n,i)=>n.gain.gain.setTargetAtTime(chaseBase[i]*chase,audio.ac.currentTime,.05));
  }

  function sampleMusicMeter(){
    if(!music.analyser)return;
    try{
      const data=new Float32Array(music.analyser.fftSize);
      music.analyser.getFloatTimeDomainData(data);
      let sum=0; for(const v of data) sum+=v*v;
      music.signalRms=Math.sqrt(sum/data.length)||0;
    }catch(_){music.signalRms=0;}
  }

  function startNativeMusic(){
    if(isMuted)return false;
    if(!ensureAudio()||!audio?.ac){
      music.lastError='NO_AUDIO_CONTEXT';
      setAudioStatusSafe('الموسيقى: تعذر فتح الصوت');
      return false;
    }
    const ac=audio.ac;
    try{
      if(ac.state!=='running') ac.resume().catch(()=>{});
      if(!buildLiveMusic()) throw new Error('MUSIC_GRAPH_FAILED');
      if(music.finalGain){
        music.finalGain.gain.cancelScheduledValues(ac.currentTime);
        music.finalGain.gain.setTargetAtTime(.08,ac.currentTime,.08);
      }
      applyMusicMix(1,0);
      music.target=world?.anyChase?'chase':'ambient';
      music.lastPlayState='playing';
      setAudioStatusSafe('الصوت: موسيقى الخلفية تعمل');
      return true;
    }catch(err){
      music.lastError=String(err?.message||err);
      music.lastPlayState='error';
      setAudioStatusSafe('الموسيقى: خطأ في محرك الصوت');
      return false;
    }
  }

  function crossfadeMusic(dt){
    if(!music.started||!music.finalGain||isMuted)return;
    const rate=Math.min(1,dt/.45);
    const wantA=music.target==='ambient'?1:0;
    const wantC=music.target==='chase'?1:0;
    music.ambientLevel += (wantA-music.ambientLevel)*rate;
    music.chaseLevel += (wantC-music.chaseLevel)*rate;
    applyMusicMix(music.ambientLevel,music.chaseLevel);
    if(audio?.ac?.state==='running')sampleMusicMeter();
  }

  function setMusicChase(chasing){
    if(!music.started||isMuted)return;
    music.target=chasing?'chase':'ambient';
  }

  function stopLocalMusic(){
    for(const group of [music.ambientNodes,music.chaseNodes]) for(const n of group){try{n.osc.stop();}catch(_){} }
    try{music.masterLfo?.stop();}catch(_){}
    music.ambientNodes=[]; music.chaseNodes=[]; music.masterLfo=null; music.masterLfoGain=null;
    music.started=false; music.ready=false; music.lastPlayState='stopped';
    music.finalGain=null;music.preGain=null;music.compressor=null;music.analyser=null;music.musicBus=null;
  }

  function createAudio(){
    try{
      const C=window.AudioContext||window.webkitAudioContext;if(!C)return null;
      const ac=new C();
      const sfxBus=ac.createGain();
      const sfxComp=ac.createDynamicsCompressor();
      sfxComp.threshold.value=-8;sfxComp.knee.value=8;sfxComp.ratio.value=5;sfxComp.attack.value=.002;sfxComp.release.value=.10;
      sfxBus.gain.value=isMuted?0:1.18;
      sfxBus.connect(sfxComp).connect(ac.destination);
      return {ac,sfxBus,sfxComp};
    }catch(err){console.warn('Audio setup failed',err);return null;}
  }

  function ensureMainTitleMusic(){
    try{
      if(!mainTitleMusic){
        mainTitleMusic=document.getElementById('mainTitleAudio') || new Audio('assets/main-title.mp3');
        mainTitleMusic.preload='auto';
        mainTitleMusic.loop=true;
        mainTitleMusic.setAttribute('playsinline','');
        mainTitleMusic.volume=0.28;
        if(!mainTitleMusic.src) mainTitleMusic.src='assets/main-title.mp3';
        mainTitleMusic.addEventListener('error',()=>{ setAudioStatusSafe('موسيقى الواجهة: تعذر تحميل الملف'); },{once:false});
      }
      mainTitleMusic.muted=isMuted;
      return mainTitleMusic;
    }catch(_){return null;}
  }

  function fadeMainTitleIn(restart=false){
    const mm=ensureMainTitleMusic();
    if(!mm||isMuted)return false;
    try{
      if(mainTitleFadeTimer)clearInterval(mainTitleFadeTimer);
      mm.muted=false;
      if(restart) mm.currentTime=0;
      if(mm.paused){
        const p=mm.play();
        if(p&&typeof p.then==='function'){
          p.then(()=>setAudioStatusSafe('الصوت: موسيقى الواجهة تعمل'))
           .catch(err=>{
             titleMusicGestureUnlocked=false;
             const msg=err&&err.name==='NotAllowedError' ? 'الصوت: سيبدأ تلقائيًا عند أول تفاعل مع اللعبة' : 'الموسيقى: تعذر تشغيل الملف';
             setAudioStatusSafe(msg);
           });
        }
      }
      const startVol=Number.isFinite(mm.volume)?Math.min(mm.volume,0.33):0.33;
      if(startVol>=0.399)return true;
      const start=performance.now(), from=startVol, target=0.40;
      mainTitleFadeTimer=setInterval(()=>{
        if(!mm){clearInterval(mainTitleFadeTimer);mainTitleFadeTimer=0;return;}
        const q=Math.min(1,(performance.now()-start)/700);
        mm.volume=from+(target-from)*(q*q*(3-2*q));
        if(q>=1){clearInterval(mainTitleFadeTimer);mainTitleFadeTimer=0;}
      },25);
      return true;
    }catch(_){return false;}
  }

  function fadeMainTitleOut(){
    const mm=mainTitleMusic;
    if(!mm)return;
    try{
      if(mainTitleFadeTimer)clearInterval(mainTitleFadeTimer);
      const from=mm.volume, start=performance.now(), duration=700;
      mainTitleFadeTimer=setInterval(()=>{
        const q=Math.min(1,(performance.now()-start)/duration);
        mm.volume=from*(1-q*q*(3-2*q));
        if(q>=1){clearInterval(mainTitleFadeTimer);mainTitleFadeTimer=0;mm.pause();mm.currentTime=0;mm.volume=0;}
      },25);
    }catch(_){try{mm.pause();mm.currentTime=0;mm.volume=0;}catch(__){}}
  }

  function ensureVaultAudio(){
    try{
      if(!vaultAudio){
        vaultAudio=new Audio('assets/vault-open.mp3');
        vaultAudio.preload='auto';
        vaultAudio.volume=.92;
      }
      vaultAudio.muted=isMuted;
      return vaultAudio;
    }catch(_){return null;}
  }

  function ensureEscapeAudio(){
    try{
      if(!escapeAudio){
        escapeAudio=new Audio('assets/escape-run.mp3');
        escapeAudio.preload='auto';
        escapeAudio.volume=.95;
      }
      escapeAudio.muted=isMuted;
      return escapeAudio;
    }catch(_){return null;}
  }

  function stopResultMusicNow(){
    try{
      if(resultMusicFadeTimer)clearInterval(resultMusicFadeTimer);
      resultMusicFadeTimer=0;
      if(resultMusic){resultMusic.pause();resultMusic.currentTime=0;resultMusic.volume=0;}
      if(gameOverMusic){gameOverMusic.pause();gameOverMusic.currentTime=0;gameOverMusic.volume=0;}
    }catch(_){}
  }

  function ensureGameOverMusic(){
    try{
      if(!gameOverMusic){
        gameOverMusic=new Audio('assets/game-over.mp3');
        gameOverMusic.preload='auto';
        gameOverMusic.loop=false;
        gameOverMusic.volume=0;
      }
      gameOverMusic.muted=isMuted;
      return gameOverMusic;
    }catch(_){return null;}
  }

  function fadeGameOverMusicIn(){
    const gm=ensureGameOverMusic();
    if(!gm||isMuted)return;
    try{
      if(resultMusicFadeTimer)clearInterval(resultMusicFadeTimer);
      gm.pause(); gm.currentTime=0; gm.muted=false; gm.volume=0;
      void gm.play();
      const target=.72, start=performance.now();
      resultMusicFadeTimer=setInterval(()=>{
        if(!gm||gm.paused){clearInterval(resultMusicFadeTimer);resultMusicFadeTimer=0;return;}
        const p=Math.min(1,(performance.now()-start)/850);
        const s=p*p*(3-2*p);
        gm.volume=target*s;
        if(p>=1){clearInterval(resultMusicFadeTimer);resultMusicFadeTimer=0;}
      },30);
    }catch(_){}
  }

  function ensureResultMusic(){
    try{
      if(!resultMusic){
        resultMusic=new Audio('assets/win-rock.mp3');
        resultMusic.preload='auto';
        resultMusic.loop=false;
        resultMusic.volume=0;
      }
      resultMusic.muted=isMuted;
      return resultMusic;
    }catch(_){return null;}
  }

  function fadeResultMusicIn(){
    const rm=ensureResultMusic();
    if(!rm||isMuted)return;
    try{
      if(resultMusicFadeTimer)clearInterval(resultMusicFadeTimer);
      rm.muted=false;
      rm.volume=0;
      void rm.play();
      const target=.20;
      const start=performance.now();
      resultMusicFadeTimer=setInterval(()=>{
        if(!rm||rm.paused){clearInterval(resultMusicFadeTimer);resultMusicFadeTimer=0;return;}
        const p=Math.min(1,(performance.now()-start)/900);
        const s=p*p*(3-2*p);
        rm.volume=target*s;
        if(p>=1){clearInterval(resultMusicFadeTimer);resultMusicFadeTimer=0;}
      },30);
    }catch(_){}
  }

  function fadeResultMusicOut(done){
    const tracks=[resultMusic,gameOverMusic].filter(Boolean);
    if(!tracks.length){ if(typeof done==='function')done(); return; }
    try{
      if(resultMusicFadeTimer)clearInterval(resultMusicFadeTimer);
      resultMusicFadeTimer=0;
      const startVols=tracks.map(t=>Math.max(0,t.volume));
      if(startVols.every(v=>v<=.001)){
        tracks.forEach(t=>{try{t.pause();t.currentTime=0;t.volume=0;}catch(_){} });
        if(typeof done==='function')done();
        return;
      }
      const start=performance.now();
      resultMusicFadeTimer=setInterval(()=>{
        const p=Math.min(1,(performance.now()-start)/850);
        const s=p*p*(3-2*p);
        tracks.forEach((t,i)=>{try{t.volume=startVols[i]*(1-s);}catch(_){}});
        if(p>=1){
          clearInterval(resultMusicFadeTimer); resultMusicFadeTimer=0;
          tracks.forEach(t=>{try{t.pause();t.currentTime=0;t.volume=0;}catch(_){}});
          if(typeof done==='function')done();
        }
      },30);
    }catch(_){
      tracks.forEach(t=>{try{t.pause();t.currentTime=0;t.volume=0;}catch(_){}});
      if(typeof done==='function')done();
    }
  }

  function setGameplayMusicAfterResult(){
    try{
      if(audio?.ac?.state==='running' && music.finalGain){
        music.finalGain.gain.cancelScheduledValues(audio.ac.currentTime);
        music.finalGain.gain.setTargetAtTime(isMuted?0:.08,audio.ac.currentTime,.08);
      }
      if(!isMuted && gameState==='PLAYING' && (!music.started || !music.ready)) startNativeMusic();
    }catch(_){}
  }

  function ensureAudio(){
    try{
      if(!audio)audio=createAudio();
      if(audio&&audio.ac.state!=='running')audio.ac.resume().catch(()=>{});
      return !!audio;
    }catch(_){return false;}
  }

  function updateAudio(dt){try{
    if(world)setMusicChase(!!world.anyChase);
    if(music.started)crossfadeMusic(dt);
    if(audio&&world?.guards?.length&&world.player){const near=Math.min(...world.guards.map(g=>dist(g,world.player)));if(near<250)playHeartbeat(near);}
  }catch(_){} }

  let heartbeatTimer=0;
  // V27 audio merge: V26 keeps the working ambient/chase BGM and footsteps; V19 supplies the other SFX.
  function playHeartbeat(near){if(!audio||isMuted)return;heartbeatTimer-=1/60;if(heartbeatTimer>0)return;heartbeatTimer=Math.max(.12,near/650);beep(92,.07,.12);setTimeout(()=>beep(118,.065,.09),75)}
  function beep(freq,dur,gain){if(!audio||audio.ac.state!=='running'||isMuted)return;try{const o=audio.ac.createOscillator(),g=audio.ac.createGain();o.frequency.value=freq;o.type='sine';g.gain.value=gain;o.connect(g).connect(audio.sfxBus);o.start();g.gain.exponentialRampToValueAtTime(.0001,audio.ac.currentTime+dur);o.stop(audio.ac.currentTime+dur+.02);}catch(_){}}
  function playSfx(kind){
    if(!audio||isMuted||audio.ac.state!=='running')return;
    try{
      const ac=audio.ac, t=ac.currentTime, bus=audio.sfxBus;
      const tone=(freq,dur,gain,type='sine',when=0,slideTo=null)=>{
        const o=ac.createOscillator(),gn=ac.createGain();o.type=type;o.frequency.setValueAtTime(freq,t+when);
        if(slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20,slideTo),t+when+dur);
        gn.gain.setValueAtTime(Math.max(.0001,gain),t+when);gn.gain.exponentialRampToValueAtTime(.0001,t+when+dur);
        o.connect(gn).connect(bus);o.start(t+when);o.stop(t+when+dur+.025);
      };
      if(kind==='key'){
        // Bright reward chime: rising two-note arpeggio.
        tone(784,.16,.15,'sine',0,988);
        tone(1174,.23,.12,'triangle',.07,1568);
        return;
      }
      if(kind==='vault'){
        // Use the dedicated, realistic steel-vault recording generated for this game.
        const va=ensureVaultAudio();
        if(va && !isMuted){
          try{ va.currentTime=0; va.muted=false; void va.play(); return; }catch(_){}
        }
        // Safe fallback if autoplay/decoding blocks the uploaded file.
        tone(58,.28,.20,'triangle',0,42);
        tone(118,.06,.12,'square',.22,92);
        tone(92,.06,.12,'square',.31,74);
        tone(70,.10,.11,'triangle',.42,52);
        tone(52,.18,.16,'sawtooth',.56,38);
        return;
      }
      if(kind==='escape'){
        const ea=ensureEscapeAudio();
        if(ea && !isMuted){
          try{ea.currentTime=0;ea.muted=false;void ea.play();return;}catch(_){}
        }
        tone(196,.12,.12,'sine',0,260);
        tone(392,.20,.10,'triangle',.08,523);
        return;
      }
      if(kind==='button'){
        tone(310,.055,.135,'square',0,260);
        tone(620,.045,.082,'triangle',.018,540);
        return;
      }
      const map={glass:[180,.15,.24,'triangle'],success:[740,.22,.16,'triangle'],alarm:[520,.16,.16,'square'],lockdown:[32,.42,.32,'sawtooth'],step:[66,.10,.22,'sine']};
      const [f,d,g,typ]=map[kind]||[160,.08,.08,'sine'];
      tone(f,d,g,typ,0);
    }catch(_){}
  }


  function playAlarmSiren(){
    playSfx('alarm');
    setTimeout(()=>playSfx('alarm'),180);
    setTimeout(()=>playSfx('alarm'),360);
  }

  function advanceToNextLevel(){
    if(!isRoundUnlocked(level.stage,level.level)) return;
    if(level.stage===3 && level.level===5){ openLevelSelect(); return; }
    if(level.level<5) level.level+=1;
    else { level.stage+=1; level.level=1; }
    level.stage=Math.min(3,level.stage); level.level=Math.min(5,level.level); level.turn=((level.stage-1)*5)+level.level;
    startRaid();
  }

  let resultRainRaf=0;
  function stopResultRain(){
    if(resultRainRaf) cancelAnimationFrame(resultRainRaf);
    resultRainRaf=0;
    for(const id of ['successRainCanvas','failureRainCanvas']){
      const c=document.getElementById(id); if(c){const x=c.getContext('2d');x.clearRect(0,0,c.width,c.height);}
    }
  }

  function startResultRain(mode){
    stopResultRain();
    const canvasEl=document.getElementById(mode==='money'?'successRainCanvas':'failureRainCanvas');
    if(!canvasEl)return;
    const host=canvasEl.parentElement;
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const resize=()=>{
      const width=Math.max(1,host.clientWidth||window.innerWidth);
      const height=Math.max(1,host.clientHeight||window.innerHeight);
      canvasEl.width=Math.floor(width*dpr);
      canvasEl.height=Math.floor(height*dpr);
    };
    resize();
    const ctx=canvasEl.getContext('2d');
    const count=mode==='money'?34:26;
    const items=Array.from({length:count},(_,i)=>({
      x:Math.random()*host.clientWidth,
      y:-40-Math.random()*host.clientHeight,
      vy:90+Math.random()*160,
      vx:(Math.random()-.5)*25,
      rot:Math.random()*Math.PI*2,
      vr:(Math.random()-.5)*2.8,
      s:.7+Math.random()*.75,
      delay:Math.random()*1.4,
      seed:i
    }));
    let start=performance.now();
    function frame(now){
      if(!canvasEl.isConnected || (mode==='money' ? gameState!=='SUCCESS' : gameState!=='FAILURE')){
        resultRainRaf=0;
        return;
      }
      const w=Math.max(1,host.clientWidth||window.innerWidth),h=Math.max(1,host.clientHeight||window.innerHeight);
      const dt=Math.min(.04,(now-start)/1000); start=now;
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      for(const it of items){
        it.y+=it.vy*dt;it.x+=it.vx*dt;it.rot+=it.vr*dt;
        if(it.y>h+60){it.y=-40-Math.random()*140;it.x=Math.random()*w;}
        const alpha=Math.min(1,Math.max(0,(it.y+80)/120));
        ctx.save();ctx.translate(it.x,it.y);ctx.rotate(it.rot);ctx.globalAlpha=alpha;
        if(mode==='money'){
          const ww=30*it.s,hh=19*it.s;
          ctx.fillStyle='#d4a72c';ctx.strokeStyle='#8e6411';ctx.lineWidth=1.5;
          ctx.beginPath();ctx.roundRect(-ww/2,-hh/2,ww,hh,5);ctx.fill();ctx.stroke();
          ctx.fillStyle='#f8df77';ctx.beginPath();ctx.arc(0,0,5.2*it.s,0,Math.PI*2);ctx.fill();
          ctx.fillStyle='#6e4e13';ctx.font=`bold ${12*it.s}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('$',0,1);
          ctx.strokeStyle='rgba(255,244,170,.55)';ctx.beginPath();ctx.moveTo(-ww*.32,0);ctx.lineTo(ww*.32,0);ctx.stroke();
        }else{
          // Wide, unmistakable handcuffs with two separated cuffs and a hollow braided-wire bridge.
          const s=1.54*it.s, rx=14.8*s, ry=11.5*s, gap=35*s;
          const metal='#c9d2d7', dark='#66717a', hi='#f1f5f6';
          ctx.lineCap='round';
          // Cuff bodies: thick outer ring + bright inner ring makes the opening obvious.
          ctx.strokeStyle=dark;ctx.lineWidth=7*s;
          ctx.beginPath();ctx.ellipse(-gap/2,0,rx,ry,0,0,Math.PI*2);ctx.stroke();
          ctx.beginPath();ctx.ellipse(gap/2,0,rx,ry,0,0,Math.PI*2);ctx.stroke();
          ctx.strokeStyle=metal;ctx.lineWidth=4.7*s;
          ctx.beginPath();ctx.ellipse(-gap/2,0,rx,ry,0,0,Math.PI*2);ctx.stroke();
          ctx.beginPath();ctx.ellipse(gap/2,0,rx,ry,0,0,Math.PI*2);ctx.stroke();
          ctx.strokeStyle=hi;ctx.lineWidth=2*s;
          ctx.beginPath();ctx.ellipse(-gap/2-1*s,-1*s,rx-2.5*s,ry-2.5*s,-.08,3.25,5.7);ctx.stroke();
          ctx.beginPath();ctx.ellipse(gap/2-1*s,-1*s,rx-2.5*s,ry-2.5*s,.08,3.65,6.1);ctx.stroke();

          // Ratchet/hinge blocks on the inner sides.
          ctx.fillStyle=metal;
          ctx.beginPath();ctx.roundRect(-gap/2+rx-2*s,-5.5*s,11*s,11*s,2.5*s);ctx.fill();
          ctx.beginPath();ctx.roundRect(gap/2-rx-9*s,-5.5*s,11*s,11*s,2.5*s);ctx.fill();
          ctx.fillStyle=hi;
          ctx.fillRect(-gap/2+rx+1*s,-3*s,4*s,2*s);
          ctx.fillRect(gap/2-rx-7*s,-3*s,4*s,2*s);

          // Hollow braided wire: three interlaced strands, intentionally spaced so the open air
          // inside the braid remains visible instead of looking like one solid metal bar.
          const left= -gap/2+rx+7*s, right=gap/2-rx-7*s, span=right-left;
          ctx.lineWidth=2.8*s;
          const braidY=[-3.8,0,3.8];
          braidY.forEach((off,j)=>{
            ctx.strokeStyle=j===1?metal:dark;
            ctx.beginPath();
            ctx.moveTo(left,off*s);
            for(let k=0;k<=10;k++) {
              const x=left+span*(k/10), y=off*s + Math.sin((k/10)*Math.PI*2 + j*Math.PI*2/3)*3.2*s;
              if(k===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);
            }
            ctx.stroke();
          });
          // Small highlights on alternating braid crossings emphasize a hollow woven cable.
          ctx.fillStyle=hi;
          for(let k=1;k<10;k+=2){
            const x=left+span*(k/10), y=Math.sin((k/10)*Math.PI*2)*2.6*s;
            ctx.beginPath();ctx.arc(x,y,1.25*s,0,Math.PI*2);ctx.fill();
          }
        }
        ctx.restore();
      }
      resultRainRaf=requestAnimationFrame(frame);
    }
      window.addEventListener('resize',resize,{once:false});
    // Draw the first frame synchronously so the effect is present immediately after transition.
    frame(performance.now());
    if(!resultRainRaf) resultRainRaf=requestAnimationFrame(frame);
  }

  // Keyboard
  window.addEventListener('keydown',e=>{const k=e.key.toLowerCase();if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(k)){e.preventDefault();input.keys.add(k)}if(k==='escape'&&gameState==='MENU')document.getElementById('howPanel').classList.add('hidden')});
  window.addEventListener('keyup',e=>input.keys.delete(e.key.toLowerCase()));

  canvas.addEventListener('pointerdown',e=>{if(gameState==='PLAYING'&&isMapFullyLoaded)ensureAudio();});

  const joystick=document.getElementById('joystick'),knob=document.getElementById('joystickKnob');
  let joyId=null;
  function joyMove(e){if(e.pointerId!==joyId)return;const r=joystick.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;let dx=e.clientX-cx,dy=e.clientY-cy;const max=r.width*.34,m=Math.hypot(dx,dy);if(m>max){dx=dx/m*max;dy=dy/m*max} input.x=dx/max;input.y=dy/max;input.joystickActive=true;knob.style.transform=`translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`}
  function joyEnd(e){if(e.pointerId!==joyId)return;joyId=null;input.x=input.y=0;input.joystickActive=false;knob.style.transform='translate(-50%,-50%)'}
  joystick.addEventListener('pointerdown',e=>{joyId=e.pointerId;joystick.setPointerCapture(e.pointerId);joyMove(e)});joystick.addEventListener('pointermove',joyMove);joystick.addEventListener('pointerup',joyEnd);joystick.addEventListener('pointercancel',joyEnd);

  let titleMusicGestureUnlocked=false;
  document.addEventListener('pointerdown',e=>{
    const btn=e.target.closest && e.target.closest('button');
    try{
      ensureAudio();
      if(!titleMusicGestureUnlocked && !isMuted && (gameState==='MENU' || gameState==='LEVELS')){
        const mm=ensureMainTitleMusic();
        if(mm && mm.src){
          titleMusicGestureUnlocked=true;
          try { mm.muted=false; mm.volume=0.28; const p=mm.play(); if(p&&typeof p.catch==='function') p.catch(()=>{ titleMusicGestureUnlocked=false; }); } catch(_) { titleMusicGestureUnlocked=false; }
          fadeMainTitleIn(false);
        }
      }
      if(btn && !btn.disabled) playSfx('button');
    }catch(_){ }
  },{passive:true});

  function handleStartButton(){
    level.stage=1; level.level=1; level.turn=1;
    // The start button is also a trusted user gesture; use it only as a silent autoplay fallback.
    try { titleMusicGestureUnlocked=true; fadeMainTitleIn(false); } catch (_) {}
    openLevelSelect();
  }
  document.getElementById('startBtn').addEventListener('click', handleStartButton);
  document.getElementById('howBtn').addEventListener('click',()=>document.getElementById('howPanel').classList.remove('hidden'));
  document.getElementById('closeHow').addEventListener('click',()=>document.getElementById('howPanel').classList.add('hidden'));
  function updateMuteUi(){
    const btn=document.getElementById('muteBtn');
    if(!btn)return;
    const icon=btn.querySelector('.btn-icon');
    const label=btn.querySelector('span:not(.btn-icon)');
    if(icon) icon.textContent=isMuted?'🔇':'🔊';
    if(label) label.textContent=isMuted?'تشغيل الصوت':'كتم الصوت';
    btn.setAttribute('aria-pressed',String(isMuted));
  }

  function setMasterMute(nextMuted){
    isMuted=!!nextMuted;
    updateMuteUi();
    try{
      if(vaultAudio){ vaultAudio.muted=isMuted; if(isMuted){ try{vaultAudio.pause();}catch(_){} } }
      if(escapeAudio){ escapeAudio.muted=isMuted; if(isMuted){ try{escapeAudio.pause();}catch(_){} } }
      if(resultMusic){ resultMusic.muted=isMuted; if(isMuted){ try{resultMusic.pause();}catch(_){} } }
      if(gameOverMusic){ gameOverMusic.muted=isMuted; if(isMuted){ try{gameOverMusic.pause();}catch(_){} } }
      if(audio?.ac){
        const now=audio.ac.currentTime;
        audio.sfxBus.gain.cancelScheduledValues(now);
        audio.sfxBus.gain.setTargetAtTime(isMuted?0:1.0,now,.025);
        if(music.finalGain){
          music.finalGain.cancelScheduledValues(now);
          music.finalGain.setTargetAtTime(isMuted?0:0.08,now,.025);
        }
      }
      if(!isMuted){
        if(gameState==='MENU' || gameState==='LEVELS') {
          try{ titleMusicGestureUnlocked=true; fadeMainTitleIn(false); }catch(_){}
        } else if(gameState==='PLAYING') {
          try{ startNativeMusic(); }catch(_){}
          setMusicChase(!!world?.anyChase);
        }
        setAudioStatusSafe('الصوت: يعمل');
      }else{
        setAudioStatusSafe('الصوت: مكتوم');
      }
    }catch(_){ }
  }

  const muteBtn=document.getElementById('muteBtn');
  if(muteBtn) muteBtn.addEventListener('click',()=>setMasterMute(!isMuted));
  updateMuteUi();
  document.getElementById('restartBtn').addEventListener('click',()=>{if(gameState==='PLAYING')buildLevel()});
  function runAfterResultFade(action){
    if(resultTransitioning)return;
    resultTransitioning=true;
    fadeResultMusicOut(()=>{
      try{action();}finally{resultTransitioning=false;}
    });
  }
  document.getElementById('retryBtn').addEventListener('click',()=>runAfterResultFade(()=>startRaid()));
  document.getElementById('nextBtn').addEventListener('click',()=>runAfterResultFade(()=>advanceToNextLevel()));
  document.getElementById('successLevelsBtn').addEventListener('click',()=>runAfterResultFade(()=>openLevelSelect()));
  document.getElementById('failureLevelsBtn').addEventListener('click',()=>runAfterResultFade(()=>openLevelSelect()));
  document.getElementById('levelsBtn').addEventListener('click',()=>{openLevelSelect()});
  document.getElementById('levelsBackBtn').addEventListener('click',()=>setState('MENU'));
  document.getElementById('levelSelectGrid').addEventListener('click',e=>{
    const card=e.target.closest('.round-card');
    if(!card)return;
    selectLevel(Number(card.dataset.stage),Number(card.dataset.round),true);
  });

  let simAccumulator=0;
  const FIXED_DT=1/60;

  function startGameRenderLoop(){
    if(gameLoopActive) return;
    gameLoopActive=true;
    simAccumulator=0;
    lastFrame=performance.now();
    gameFrameRaf=requestAnimationFrame(frame);
  }

  function stopGameRenderLoop(){
    gameLoopActive=false;
    simAccumulator=0;
    if(gameFrameRaf){
      cancelAnimationFrame(gameFrameRaf);
      gameFrameRaf=0;
    }
  }

  function frame(now){
    if(!gameLoopActive) return;
    const raw=Math.min(.20,Math.max(0,(now-lastFrame)/1000));
    lastFrame=now; simAccumulator+=raw;
    let steps=0;
    while(simAccumulator>=FIXED_DT && steps<4){
      try{update(FIXED_DT,now)}catch(err){console.error('update',err)}
      simAccumulator-=FIXED_DT; steps++;
    }
    if(steps===4) simAccumulator=0;
    try{draw(now)}catch(err){console.error('draw',err)}
    gameFrameRaf=requestAnimationFrame(frame);
  }
  // Development invariants: these helpers are lexical functions inside this IIFE,
  // so validate them directly instead of looking for them on globalThis. The previous
  // globalThis check itself crashed the entire game before the render loop started.
  if (typeof canGuardStandAt !== 'function' ||
      typeof pickGuardDetour !== 'function' ||
      typeof findGridPath !== 'function') {
    throw new Error('Guard movement dependencies are missing');
  }
  buildLevel(); // generates an inert world while still on menu; gameplay checks remain gated until state PLAYING.
  renderMenuActorsOnce();
  renderLevelSelect();
  setState('MENU');
  // Best-effort audible autoplay. Browsers may block it until a normal page interaction;
  // there is deliberately no dedicated 'play music' button.
  try {
    const mm=ensureMainTitleMusic();
    if(mm){
      mm.autoplay=true;
      mm.muted=!!isMuted;
      const p=mm.play();
      if(p&&typeof p.catch==='function') p.catch(()=>{ titleMusicGestureUnlocked=false; });
    }
  } catch(_) {}
})();
