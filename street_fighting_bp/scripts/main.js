import { world, system, EntityComponentTypes } from "@minecraft/server";

// ==========================================
// CONFIGURATION & GLOBAL STATE
// ==========================================
const STAMINA_MAX = 100;
const STAMINA_REGEN = 4;
const STAMINA_ATTACK_COST = 10;
const STAMINA_HEAVY_COST = 25;
const STAMINA_GUARD_COST = 15;

const playerStamina = new Map(); // playerId -> currentStamina
const playerGuardTime = new Map(); // playerId -> timestamp
const playerGuardHits = new Map(); // playerId -> consecutive hit count
const playerStunState = new Map(); // playerId -> stun end timestamp
const playerPunchArm = new Map(); // playerId -> "left" | "right"
const cameraEnabled = new Map(); // playerId -> boolean
const lockedLocations = new Map(); // entityId -> { x, y, z, dimension }
const carriedPlayers = new Map(); // carrierId -> downedPlayerId

// Utility function to get entity health component
function getHealthComponent(entity) {
  try {
    return entity.getComponent(EntityComponentTypes.Health);
  } catch (e) {
    return null;
  }
}

// Utility function to get entity health
function getHealth(entity) {
  const hpComp = getHealthComponent(entity);
  return hpComp ? hpComp.currentValue : 20;
}

// Utility function to set entity health safely
function setHealth(entity, value) {
  const hpComp = getHealthComponent(entity);
  if (hpComp) {
    const targetValue = Math.max(1, Math.min(value, hpComp.effectiveMax));
    hpComp.setCurrentValue(targetValue);
  }
}

// Get player faction tag ("team_a" or "team_b")
function getFaction(entity) {
  if (!entity) return null;
  if (entity.hasTag("team_a") || entity.typeId === "street:enemy_a") return "team_a";
  if (entity.hasTag("team_b") || entity.typeId === "street:enemy_b") return "team_b";
  return null;
}

// Equips shop jacket to chest armor slot
function equipShopJacket(player, faction) {
  try {
    const itemType = faction === "team_a" ? "street:shop_jacket_a" : "street:shop_jacket_b";
    player.runCommandAsync(`item replace entity @s slot.armor.chest 0 ${itemType} 1`);
  } catch (e) {}
}

// Checks if player is wearing Rider Helmet
function isWearingHelmet(player) {
  try {
    const equippable = player.getComponent(EntityComponentTypes.Equippable);
    if (!equippable) return false;
    const headItem = equippable.getEquipment("Head");
    return headItem && headItem.typeId === "street:helmet";
  } catch (e) {
    return false;
  }
}

// Get mainhand item type id
function getMainhandItemType(entity) {
  try {
    const equippable = entity.getComponent(EntityComponentTypes.Equippable);
    if (!equippable) return null;
    const mainhand = equippable.getEquipment("Mainhand");
    return mainhand ? mainhand.typeId : null;
  } catch (e) {
    return null;
  }
}

// Check if player is currently stunned
function isStunned(player) {
  const stunEnd = playerStunState.get(player.id);
  if (!stunEnd) return false;
  if (Date.now() > stunEnd) {
    playerStunState.delete(player.id);
    return false;
  }
  return true;
}

// Lock entity position for cinematic/stun duration
function lockEntityPosition(entity, durationMs) {
  if (!entity) return;
  const loc = entity.location;
  lockedLocations.set(entity.id, {
    x: loc.x,
    y: loc.y,
    z: loc.z,
    dimension: entity.dimension,
    until: Date.now() + durationMs
  });
}

// Helper to find nearest opponent within radius
function getNearestOpponent(player, radius = 5) {
  const playerLoc = player.location;
  const playerFaction = getFaction(player);
  let closest = null;
  let minDistanceSq = radius * radius;

  for (const other of player.dimension.getEntities()) {
    if (other.id === player.id) continue;
    const otherFaction = getFaction(other);
    // Ignore same faction
    if (playerFaction && otherFaction && playerFaction === otherFaction) continue;

    const loc = other.location;
    const dx = loc.x - playerLoc.x;
    const dy = loc.y - playerLoc.y;
    const dz = loc.z - playerLoc.z;
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq <= minDistanceSq) {
      minDistanceSq = distSq;
      closest = other;
    }
  }
  return closest;
}

// ==========================================
// 1. OVER-THE-SHOULDER CAMERA CONTROL SYSTEM
// ==========================================
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    // Enable camera mode by default for boxing feel if not disabled
    const isCamActive = cameraEnabled.get(player.id) ?? true;
    if (!isCamActive) continue;

    try {
      const loc = player.location;
      const rot = player.getRotation(); // { x: pitch, y: yaw }
      const yawRad = (rot.y * Math.PI) / 180;

      // Calculate Over-The-Shoulder / Side View Offset (Roblox Boxing Style)
      // Behind: -2.2, Right offset: +0.7, Height offset: +1.7
      const forwardX = -Math.sin(yawRad);
      const forwardZ = Math.cos(yawRad);
      const rightX = Math.cos(yawRad);
      const rightZ = Math.sin(yawRad);

      const camX = loc.x - forwardX * 2.2 + rightX * 0.7;
      const camY = loc.y + 1.8;
      const camZ = loc.z - forwardZ * 2.2 + rightZ * 0.7;

      const targetX = loc.x + forwardX * 3.0;
      const targetY = loc.y + 1.5;
      const targetZ = loc.z + forwardZ * 3.0;

      player.camera.setCamera("minecraft:free", {
        location: { x: camX, y: camY, z: camZ },
        facingLocation: { x: targetX, y: targetY, z: targetZ },
        easeOptions: {
          easeTime: 0.1,
          easeType: "Linear"
        }
      });
    } catch (e) {}
  }
}, 1);

// Maintain Locked Entity Positions (for Slow-Mo Cutscenes & Stun)
system.runInterval(() => {
  const now = Date.now();
  for (const [entityId, lockData] of lockedLocations.entries()) {
    if (now > lockData.until) {
      lockedLocations.delete(entityId);
      continue;
    }
    // Teleport back to lock point to freeze position
    for (const player of world.getAllPlayers()) {
      if (player.id === entityId) {
        player.teleport({ x: lockData.x, y: lockData.y, z: lockData.z }, { dimension: lockData.dimension });
      }
    }
  }
}, 1);

// ==========================================
// 2. FACTION SELECTION & ITEM USAGE / SKILLS
// ==========================================
world.afterEvents.itemUse.subscribe((event) => {
  const player = event.source;
  const item = event.itemStack;
  if (!player || !item) return;

  const now = Date.now();

  // Faction Badges & Shop Jackets
  if (item.typeId === "street:faction_a" || item.typeId === "street:shop_jacket_a") {
    player.removeTag("team_b");
    player.addTag("team_a");
    equipShopJacket(player, "team_a");
    player.runCommandAsync(`playsound street.talk @s ~ ~ ~ 1.0 1.0`);
    player.sendMessage("§b[Boxing Add-on] §aคุณได้เข้าร่วม §1แก๊ง A (สถาบันเสื้อกรมท่า) §aเรียบร้อยแล้ว!");
  } else if (item.typeId === "street:faction_b" || item.typeId === "street:shop_jacket_b") {
    player.removeTag("team_a");
    player.addTag("team_b");
    equipShopJacket(player, "team_b");
    player.runCommandAsync(`playsound street.talk @s ~ ~ ~ 1.0 1.0`);
    player.sendMessage("§b[Boxing Add-on] §aคุณได้เข้าร่วม §cแก๊ง B (สถาบันเสื้อเลือดหมู) §aเรียบร้อยแล้ว!");
  }

  // Camera Mode Toggle Item (Boxing Gloves toggles camera or stance)
  if (item.typeId === "street:boxing_gloves") {
    const currentCam = cameraEnabled.get(player.id) ?? true;
    cameraEnabled.set(player.id, !currentCam);
    if (!currentCam) {
      player.sendMessage("§a[Boxing Add-on] 🎥 เปิดใช้งานมุมกล้อง Over-The-Shoulder");
    } else {
      player.camera.clear();
      player.sendMessage("§c[Boxing Add-on] 🎥 ปิดใช้งานมุมกล้อง (กลับเป็นมุมมองปกติ)");
    }
  }

  // 3. SYNCED CINEMATIC SLOW-MO SKILLS (Dash & Counter)
  if (item.typeId === "street:skill_dash") {
    triggerDashSlowMo(player);
  } else if (item.typeId === "street:skill_counter") {
    triggerCounterSlowMo(player);
  }

  // Guard tracking on item use
  playerGuardTime.set(player.id, now);
});

// ==========================================
// 3. CINEMATIC SLOW-MO MECHANICS (DASH & COUNTER)
// ==========================================
function triggerDashSlowMo(player) {
  if (isStunned(player) || player.hasTag("downed")) return;

  const opponent = getNearestOpponent(player, 6);
  const durationMs = 3000; // 3 seconds slow-mo cutscene

  // Lock positions for player and opponent
  lockEntityPosition(player, durationMs);
  if (opponent) {
    lockEntityPosition(opponent, durationMs);
  }

  // Play Synced Slow-Mo Dash Animation on player (using stretched animation keyframes)
  player.runCommandAsync(`playanimation @s animation.player.dash_slowmo default 1`);
  player.runCommandAsync(`playsound street.hit @a ~ ~ ~ 0.5 0.5`);
  player.onScreenDisplay.setActionBar("§b⚡ CINEMATIC SLOW-MO: DASH!");

  if (opponent && opponent.typeId === "minecraft:player") {
    opponent.runCommandAsync(`playanimation @s animation.player.dash_slowmo default 1`);
    opponent.runCommandAsync(`playsound street.hit @a ~ ~ ~ 0.5 0.5`);
    opponent.onScreenDisplay.setActionBar("§e⚡ OPPONENT DASH SLOW-MO!");
  }

  world.sendMessage(`§b[Cinematic] §e${player.nameTag || "นักมวย"} ใช้พุ่งหลบสโลว์โมชัน!`);
}

function triggerCounterSlowMo(player) {
  if (isStunned(player) || player.hasTag("downed")) return;

  const opponent = getNearestOpponent(player, 6);
  const durationMs = 3500; // 3.5 seconds slow-mo cutscene

  // Lock positions for player and opponent
  lockEntityPosition(player, durationMs);
  if (opponent) {
    lockEntityPosition(opponent, durationMs);
  }

  // Play Synced Slow-Mo Counter Animation
  player.runCommandAsync(`playanimation @s animation.player.counter_slowmo default 1`);
  player.runCommandAsync(`playsound street.hit @a ~ ~ ~ 0.5 0.4`);
  player.onScreenDisplay.setActionBar("§c💥 CINEMATIC SLOW-MO: COUNTER PUNCH!");

  if (opponent) {
    if (opponent.typeId === "minecraft:player") {
      opponent.runCommandAsync(`playanimation @s animation.player.punch_right default 1`);
      opponent.onScreenDisplay.setActionBar("§c⚠️ คุณกำลังโดนหมัดสวน Counter Slow-Mo!");
    }
  }

  // Apply counter impact damage at 2.0s mark
  system.runTimeout(() => {
    if (opponent) {
      const oppHp = getHealth(opponent);
      setHealth(opponent, Math.max(1, oppHp - 12)); // Heavy counter strike damage
      opponent.runCommandAsync(`playsound street.hit @a ~ ~ ~ 1.0 0.6`);
    }
  }, 40); // 40 ticks = 2.0 seconds

  world.sendMessage(`§c[Cinematic] §e${player.nameTag || "นักมวย"} สวนหมัด Counter Slow-Mo สมจริง!`);
}

// Track sneaking / guarding state in interval
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (isStunned(player)) {
      // Play stunned animation loop
      player.runCommandAsync(`playanimation @s animation.player.stunned default 1`);
      player.onScreenDisplay.setActionBar("§c💫 GUARD BREAK! ติดสถานะ Stun มึนชั่วคราว");
      continue;
    }

    if (player.isSneaking) {
      if (!playerGuardTime.has(player.id)) {
        playerGuardTime.set(player.id, Date.now());
      }
    } else {
      const last = playerGuardTime.get(player.id);
      if (last && Date.now() - last > 1000) {
        playerGuardTime.delete(player.id);
        playerGuardHits.set(player.id, 0); // Reset guard hits when guard released
      }
    }
  }
}, 5);

// ==========================================
// 4. COMBAT MECHANICS (M1 LIGHT PUNCH / M2 HEAVY PUNCH / GUARD BREAK)
// ==========================================
world.afterEvents.entityHurt.subscribe((event) => {
  const victim = event.hurtEntity;
  const attacker = event.damageSource.damagingEntity;
  let damage = event.damage;

  if (!victim) return;

  const victimFaction = getFaction(victim);
  const attackerFaction = getFaction(attacker);
  const currentHp = getHealth(victim);
  const hpComp = getHealthComponent(victim);
  const maxHp = hpComp ? hpComp.effectiveMax : 20;

  // 1. FRIENDLY FIRE PROTECTION
  if (victimFaction && attackerFaction && victimFaction === attackerFaction && victim !== attacker) {
    setHealth(victim, Math.min(maxHp, currentHp + damage));
    if (attacker && attacker.typeId === "minecraft:player") {
      attacker.onScreenDisplay.setActionBar("§c❌ ห้ามโจมตีพวกเดียวกัน!");
    }
    return;
  }

  // 2. DOWNED PREVENT LETHAL DAMAGE
  if (victim.hasTag("downed")) {
    setHealth(victim, Math.min(maxHp, currentHp + damage));
    return;
  }

  // Helmet Protection
  if (victim.typeId === "minecraft:player" && isWearingHelmet(victim) && damage >= 5) {
    const reducedDamage = damage * 0.3;
    setHealth(victim, Math.min(maxHp, currentHp + reducedDamage));
    damage *= 0.7;
  }

  // Check health for Downed Mechanics
  if (currentHp <= 10 && !victim.hasTag("downed")) {
    setHealth(victim, 10);
    victim.addTag("downed");

    victim.runCommandAsync(`effect @s resistance 99999 255 true`);
    victim.runCommandAsync(`playsound street.down @a ~ ~ ~ 1.0 1.0`);
    victim.runCommandAsync(`effect @s blindness 99999 1 true`);
    victim.runCommandAsync(`effect @s darkness 99999 1 true`);
    victim.runCommandAsync(`effect @s slowness 99999 255 true`);

    if (victim.typeId === "minecraft:player") {
      victim.sendMessage("§c🆘 คุณล้มสลบ! รอกำลังเสริมแก๊งเดียวกันมาชุบชีวิตหรืออุ้มหนี");
    }
    world.sendMessage(`§e[Boxing Alert] §c${victim.nameTag || "สมาชิก"} ล้มสลบลงแล้ว!`);
    return;
  }

  // ATTACKER PUNCH ANIMATION (M1 Light Punch / M2 Heavy Punch)
  if (attacker && attacker.typeId === "minecraft:player" && !isStunned(attacker)) {
    const isAttackerSneaking = attacker.isSneaking;

    if (isAttackerSneaking) {
      // M2 HEAVY PUNCH (Sneak + Attack) -> Windup heavy punch that PIERCES GUARD
      attacker.runCommandAsync(`playanimation @s animation.player.heavy_punch default 1`);
      attacker.runCommandAsync(`playsound street.hit @a ~ ~ ~ 1.2 0.7`);
      attacker.onScreenDisplay.setActionBar("§c💥 M2 HEAVY PUNCH (หมัดหนักทะลุการ์ด!)");

      // Deduct Stamina for Heavy Punch
      let stamina = playerStamina.get(attacker.id) ?? STAMINA_MAX;
      stamina = Math.max(0, stamina - STAMINA_HEAVY_COST);
      playerStamina.set(attacker.id, stamina);

      // HEAVY PUNCH PIERCES GUARD (ทะลุการตั้งการ์ด) & TRIGGERS GUARD BREAK INSTANTLY
      if (victim.typeId === "minecraft:player") {
        const isVictimGuarding = victim.isSneaking || playerGuardTime.has(victim.id);
        if (isVictimGuarding) {
          triggerGuardBreak(victim);
          victim.sendMessage("§c💥 คุณถูก M2 Heavy Punch ชกทะลุการ์ดจนการ์ดแตก!");
        }
      }
    } else {
      // M1 LIGHT PUNCH (Alternating Left & Right Punch)
      const lastArm = playerPunchArm.get(attacker.id) || "right";
      const nextArm = lastArm === "left" ? "right" : "left";
      playerPunchArm.set(attacker.id, nextArm);

      const anim = nextArm === "left" ? "animation.player.punch_left" : "animation.player.punch_right";
      attacker.runCommandAsync(`playanimation @s ${anim} default 1`);
      attacker.runCommandAsync(`playsound street.hit @a ~ ~ ~ 0.9 1.1`);

      // Deduct Stamina for M1
      let stamina = playerStamina.get(attacker.id) ?? STAMINA_MAX;
      stamina = Math.max(0, stamina - STAMINA_ATTACK_COST);
      playerStamina.set(attacker.id, stamina);
    }
  }

  // 3. PARRY, GUARD & GUARD BREAK SYSTEM
  if (victim.typeId === "minecraft:player" && !isStunned(victim)) {
    const isGuarding = victim.isSneaking || playerGuardTime.has(victim.id);
    const isAttackerSneaking = attacker && attacker.isSneaking;

    // Normal Guard check (if not bypassed by Heavy Punch)
    if (isGuarding && !isAttackerSneaking) {
      const guardStart = playerGuardTime.get(victim.id) || Date.now();
      const timeDiff = Date.now() - guardStart;

      // Increment Guard Hits
      let hits = (playerGuardHits.get(victim.id) || 0) + 1;
      playerGuardHits.set(victim.id, hits);

      // Deduct Guard Stamina
      let stamina = playerStamina.get(victim.id) ?? STAMINA_MAX;
      stamina = Math.max(0, stamina - STAMINA_GUARD_COST);
      playerStamina.set(victim.id, stamina);

      // Check Guard Break (3 consecutive hits taken while guarding)
      if (hits >= 3 || stamina <= 0) {
        triggerGuardBreak(victim);
        return;
      }

      if (timeDiff <= 500) {
        // PERFECT PARRY (within 0.5s)
        setHealth(victim, Math.min(maxHp, currentHp + damage));
        victim.runCommandAsync(`playsound street.hit @a ~ ~ ~ 1.0 1.3`);
        victim.onScreenDisplay.setActionBar("§e⚡ PERFECT PARRY! (สะท้อนการโจมตี)");

        if (attacker) {
          attacker.runCommandAsync(`playsound street.hit @a ~ ~ ~ 1.0 0.8`);
        }
        return;
      } else {
        // NORMAL GUARD (80% Damage Reduction)
        const refundedDamage = damage * 0.8;
        setHealth(victim, Math.min(maxHp, currentHp + refundedDamage));
        victim.runCommandAsync(`playsound street.hit @a ~ ~ ~ 0.8 1.0`);
        victim.onScreenDisplay.setActionBar(`§b🛡️ ตั้งการ์ดบล็อก (เกราะรับการปะทะ ${hits}/3)`);
        return;
      }
    }
  }

  // 5. REALISM KNOCKBACK ADJUSTMENT
  if (attacker && !victim.hasTag("downed")) {
    const weapon = getMainhandItemType(attacker);
    if (weapon !== "street:iron_pipe") {
      try {
        const viewDir = attacker.getViewDirection();
        victim.applyImpulse({
          x: viewDir.x * 0.25,
          y: 0.1,
          z: viewDir.z * 0.25
        });
      } catch (e) {}
    }
  }

  victim.runCommandAsync(`playsound street.hit @a ~ ~ ~ 0.8 1.0`);
});

// Trigger Guard Break Stun
function triggerGuardBreak(player) {
  const stunDurationMs = 3000; // 3 seconds stun
  playerStunState.set(player.id, Date.now() + stunDurationMs);
  playerGuardHits.set(player.id, 0);

  // Lock position during stun
  lockEntityPosition(player, stunDurationMs);

  player.runCommandAsync(`playanimation @s animation.player.stunned default 1`);
  player.runCommandAsync(`playsound street.down @a ~ ~ ~ 1.0 0.7`);
  player.onScreenDisplay.setActionBar("§c💫 GUARD BREAK! (ติดสถานะ Stun มึนชั่วคราว)");
  player.sendMessage("§c💫 [Guard Break] การ์ดของคุณแตก! ติดสถานะ Stun ยืนมึน 3 วินาที");
}

// ==========================================
// STAMINA REGENERATION & ACTIONBAR DISPLAY TICK
// ==========================================
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    let stamina = playerStamina.get(player.id) ?? STAMINA_MAX;

    // Regenerate stamina if not sneaking or stunned
    if (stamina < STAMINA_MAX && !player.isSneaking && !isStunned(player)) {
      stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN);
      playerStamina.set(player.id, stamina);
    }

    // Display Stamina Bar on ActionBar if not downed or stunned
    if (!player.hasTag("downed") && !isStunned(player)) {
      const bars = Math.floor((stamina / STAMINA_MAX) * 10);
      const progressBar = "█".repeat(bars) + "▒".repeat(10 - bars);
      const color = stamina > 30 ? "§a" : "§c";
      player.onScreenDisplay.setActionBar(`⚡ Stamina: ${color}[${progressBar}] ${stamina}/${STAMINA_MAX}`);
    }
  }
}, 10);

// ==========================================
// REVIVE & CARRY INTERACTION SYSTEM
// ==========================================
world.afterEvents.playerInteractWithEntity.subscribe((event) => {
  const player = event.player;
  const target = event.target;

  if (!player || !target) return;

  const playerFaction = getFaction(player);
  const targetFaction = getFaction(target);

  if (target.hasTag("downed")) {
    if (playerFaction && targetFaction && playerFaction === targetFaction) {
      if (player.isSneaking) {
        if (carriedPlayers.get(player.id) === target.id) {
          carriedPlayers.delete(player.id);
          player.sendMessage("§e[Boxing Add-on] คุณได้วางเพื่อนลงแล้ว");
        } else {
          carriedPlayers.set(player.id, target.id);
          player.sendMessage(`§a[Boxing Add-on] คุณกำลังอุ้ม ${target.nameTag || "เพื่อน"} หนี!`);
        }
      } else {
        target.removeTag("downed");
        target.runCommandAsync(`effect @s clear`);
        setHealth(target, 12);

        player.runCommandAsync(`playsound street.talk @a ~ ~ ~ 1.0 1.0`);
        player.sendMessage(`§a[Boxing Add-on] คุณได้ชุบชีวิต ${target.nameTag || "เพื่อนในแก๊ง"} แล้ว!`);
        if (target.typeId === "minecraft:player") {
          target.sendMessage(`§a[Boxing Add-on] ${player.nameTag || "เพื่อนร่วมแก๊ง"} ได้ชุบชีวิตคุณแล้ว!`);
        }
      }
    } else {
      player.sendMessage("§c❌ คุณไม่สามารถชุบชีวิตคนต่างแก๊งได้!");
    }
  }
});

// Update Position for Carried Players
system.runInterval(() => {
  for (const [carrierId, downedId] of carriedPlayers.entries()) {
    let carrier = null;
    let downed = null;

    for (const p of world.getAllPlayers()) {
      if (p.id === carrierId) carrier = p;
      if (p.id === downedId) downed = p;
    }

    if (carrier && downed && downed.hasTag("downed")) {
      const loc = carrier.location;
      const view = carrier.getViewDirection();
      downed.teleport({
        x: loc.x - view.x * 0.8,
        y: loc.y + 0.2,
        z: loc.z - view.z * 0.8
      }, {
        dimension: carrier.dimension
      });
    } else {
      carriedPlayers.delete(carrierId);
    }
  }
}, 2);
