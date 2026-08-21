import { world, system, EntityComponentTypes } from "@minecraft/server";

// ==========================================
// CONFIGURATION & GLOBAL STATE
// ==========================================
const STAMINA_MAX = 100;
const STAMINA_REGEN = 4;
const STAMINA_ATTACK_COST = 10;
const STAMINA_GUARD_COST = 15;

const playerStamina = new Map(); // playerId -> currentStamina
const playerGuardTime = new Map(); // playerId -> timestamp
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

// Equips shop jacket to chest armor slot using MC Bedrock 1.20+ command syntax
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

// ==========================================
// FACTION SELECTION & ITEM USAGE
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
    player.sendMessage("§b[Street Fighting] §aคุณได้เข้าร่วม §1แก๊ง A (สถาบันเสื้อกรมท่า) §aเรียบร้อยแล้ว!");
  } else if (item.typeId === "street:faction_b" || item.typeId === "street:shop_jacket_b") {
    player.removeTag("team_a");
    player.addTag("team_b");
    equipShopJacket(player, "team_b");
    player.runCommandAsync(`playsound street.talk @s ~ ~ ~ 1.0 1.0`);
    player.sendMessage("§b[Street Fighting] §aคุณได้เข้าร่วม §cแก๊ง B (สถาบันเสื้อเลือดหมู) §aเรียบร้อยแล้ว!");
  }

  // Guard tracking on item use
  playerGuardTime.set(player.id, now);
});

// Track sneaking / guarding state in interval
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (player.isSneaking) {
      if (!playerGuardTime.has(player.id)) {
        playerGuardTime.set(player.id, Date.now());
      }
    } else {
      // Keep guard time for 1 second after releasing sneak
      const last = playerGuardTime.get(player.id);
      if (last && Date.now() - last > 1000) {
        playerGuardTime.delete(player.id);
      }
    }
  }
}, 5);

// ==========================================
// FRIENDLY FIRE & COMBAT MECHANICS (PARRY/STAMINA/KNOCKBACK/WEAPONS)
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

  // 1. NO FRIENDLY FIRE
  if (victimFaction && attackerFaction && victimFaction === attackerFaction && victim !== attacker) {
    // Refund damage taken
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

  // Helmet Protection against critical/high damage
  if (victim.typeId === "minecraft:player" && isWearingHelmet(victim) && damage >= 5) {
    const reducedDamage = damage * 0.3; // 30% damage reduction
    setHealth(victim, Math.min(maxHp, currentHp + reducedDamage));
    damage *= 0.7;
  }

  // Check health for Downed Mechanics (Trigger at half HP or less)
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
    world.sendMessage(`§e[Street Alert] §c${victim.nameTag || "สมาชิก"} ล้มสลบลงแล้ว!`);
    return;
  }

  // 3. PARRY & GUARD SYSTEM
  if (victim.typeId === "minecraft:player") {
    const isGuarding = victim.isSneaking || playerGuardTime.has(victim.id);
    if (isGuarding) {
      const guardStart = playerGuardTime.get(victim.id) || Date.now();
      const timeDiff = Date.now() - guardStart;

      // Deduct Guard Stamina
      let stamina = playerStamina.get(victim.id) ?? STAMINA_MAX;
      stamina = Math.max(0, stamina - STAMINA_GUARD_COST);
      playerStamina.set(victim.id, stamina);

      if (timeDiff <= 500) {
        // PERFECT PARRY (within 0.5s) -> Refund 100% damage
        setHealth(victim, Math.min(maxHp, currentHp + damage));
        victim.runCommandAsync(`playsound street.hit @a ~ ~ ~ 1.0 1.2`);
        victim.onScreenDisplay.setActionBar("§e⚡ PERFECT PARRY! (สะท้อนการโจมตี)");

        if (attacker) {
          attacker.runCommandAsync(`effect @s slowness 3 2 true`);
          attacker.runCommandAsync(`effect @s weakness 3 2 true`);
          attacker.runCommandAsync(`playsound street.hit @a ~ ~ ~ 1.0 0.8`);
        }
        return;
      } else {
        // NORMAL GUARD (80% Damage Reduction) -> Refund 80% damage
        const refundedDamage = damage * 0.8;
        setHealth(victim, Math.min(maxHp, currentHp + refundedDamage));
        victim.runCommandAsync(`playsound street.hit @a ~ ~ ~ 0.8 1.0`);
        victim.onScreenDisplay.setActionBar("§b🛡️ บล็อกสำเร็จ (ลดความเสียหาย 80%)");
        return;
      }
    }
  }

  // 4. STAMINA SYSTEM & CUSTOM WEAPON EFFECTS FOR ATTACKER
  if (attacker) {
    if (attacker.typeId === "minecraft:player") {
      let stamina = playerStamina.get(attacker.id) ?? STAMINA_MAX;
      stamina = Math.max(0, stamina - STAMINA_ATTACK_COST);
      playerStamina.set(attacker.id, stamina);

      if (stamina <= 0) {
        attacker.runCommandAsync(`effect @s slowness 3 1 true`);
        attacker.onScreenDisplay.setActionBar("§c⚡ เหนื่อยล้า! สตามินาหมด (เคลื่อนที่ช้าลง)");
      }
    }

    // Custom Weapon Effects
    const weapon = getMainhandItemType(attacker);
    if (weapon === "street:wrench") {
      // Pipe Wrench: Stun Chance
      if (Math.random() < 0.35) {
        victim.runCommandAsync(`effect @s slowness 2 2 true`);
        victim.runCommandAsync(`effect @s weakness 2 2 true`);
      }
    } else if (weapon === "street:iron_pipe") {
      // Iron Pipe: Extra Knockback
      try {
        const viewDir = attacker.getViewDirection();
        victim.applyImpulse({
          x: viewDir.x * 0.6,
          y: 0.2,
          z: viewDir.z * 0.6
        });
      } catch (e) {}
    }
  }

  // 5. REALISM KNOCKBACK ADJUSTMENT (Stagger push back for standard attacks)
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

  // Play Hit Voice Sound
  victim.runCommandAsync(`playsound street.hit @a ~ ~ ~ 0.8 1.0`);
});

// ==========================================
// STAMINA REGENERATION & ACTIONBAR DISPLAY TICK
// ==========================================
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    let stamina = playerStamina.get(player.id) ?? STAMINA_MAX;

    // Regenerate stamina
    if (stamina < STAMINA_MAX && !player.isSneaking) {
      stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN);
      playerStamina.set(player.id, stamina);
    }

    // Display Stamina Bar on ActionBar if not downed
    if (!player.hasTag("downed")) {
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

  // Check if target is downed
  if (target.hasTag("downed")) {
    // Only same faction can revive or carry
    if (playerFaction && targetFaction && playerFaction === targetFaction) {
      if (player.isSneaking) {
        // CARRY MECHANIC (Sneak + Interact)
        if (carriedPlayers.get(player.id) === target.id) {
          // Drop carried player
          carriedPlayers.delete(player.id);
          player.sendMessage("§e[Street Fighting] คุณได้วางเพื่อนลงแล้ว");
        } else {
          // Carry player
          carriedPlayers.set(player.id, target.id);
          player.sendMessage(`§a[Street Fighting] คุณกำลังอุ้ม ${target.nameTag || "เพื่อน"} หนี!`);
        }
      } else {
        // REVIVE MECHANIC (Normal Interact)
        target.removeTag("downed");
        target.runCommandAsync(`effect @s clear`);
        setHealth(target, 12); // Restore to 60% HP

        player.runCommandAsync(`playsound street.talk @a ~ ~ ~ 1.0 1.0`);
        player.sendMessage(`§a[Street Fighting] คุณได้ชุบชีวิต ${target.nameTag || "เพื่อนในแก๊ง"} แล้ว!`);
        if (target.typeId === "minecraft:player") {
          target.sendMessage(`§a[Street Fighting] ${player.nameTag || "เพื่อนร่วมแก๊ง"} ได้ชุบชีวิตคุณแล้ว!`);
        }
      }
    } else {
      player.sendMessage("§c❌ คุณไม่สามารถชุบชีวิตคนต่างแก๊งได้!");
    }
  }
});

// Update Position for Carried Players in tick
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
      // Position behind the carrier
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
