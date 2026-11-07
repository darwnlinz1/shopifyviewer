/**
 * scripts/bulk-create-50.mjs
 *
 * Script to automatically generate and register 50 profiles for the 50 stores
 * into SiteViewer's profile store (profiles/profiles.json).
 */
import { ProfileStore } from "../dist/profiles/store.js";
import { loadConfig } from "../dist/config.js";

const STORES = [
  // 1. Fashion & Streetwear
  { name: "Kith", url: "https://kith.com" },
  { name: "Gymshark", url: "https://www.gymshark.com" },
  { name: "Taylor Stitch", url: "https://www.taylorstitch.com" },
  { name: "Chubbies Shorts", url: "https://www.chubbiesshorts.com" },
  { name: "Fashion Nova", url: "https://www.fashionnova.com" },

  // 2. Footwear & Sneakers
  { name: "Allbirds", url: "https://www.allbirds.com" },
  { name: "Tropicfeel", url: "https://www.tropicfeel.com" },
  { name: "Vessi Footwear", url: "https://vessi.com" },
  { name: "Thursday Boot Co", url: "https://thursdayboots.com" },
  { name: "Oliver Cabell", url: "https://olivercabell.com" },

  // 3. Beauty & Skincare
  { name: "Kylie Cosmetics", url: "https://kyliecosmetics.com" },
  { name: "Glossier", url: "https://www.glossier.com" },
  { name: "Fenty Beauty", url: "https://fentybeauty.com" },
  { name: "The Nue Co", url: "https://www.thenueco.com" },
  { name: "Drunk Elephant", url: "https://www.drunkelephant.com" },

  // 4. Watches & Jewelry
  { name: "MVMT Watches", url: "https://www.mvmt.com" },
  { name: "Cluse", url: "https://cluse.com" },
  { name: "Mejuri", url: "https://mejuri.com" },
  { name: "Pura Vida Bracelets", url: "https://www.puravidabracelets.com" },
  { name: "Spinnaker Watches", url: "https://spinnaker-watches.com" },

  // 5. Fitness & Sportswear
  { name: "Alo Yoga", url: "https://www.aloyoga.com" },
  { name: "Vuori Clothing", url: "https://vuoriclothing.com" },
  { name: "Ten Thousand", url: "https://www.tenthousand.cc" },
  { name: "Alphalete Athletics", url: "https://alphaleteathletics.com" },
  { name: "NOBULL", url: "https://www.nobullproject.com" },

  // 6. Electronics & Accessories
  { name: "Quad Lock", url: "https://www.quadlockcase.com" },
  { name: "Keychron", url: "https://www.keychron.com" },
  { name: "Peak Design", url: "https://www.peakdesign.com" },
  { name: "Moment Lens", url: "https://www.shopmoment.com" },
  { name: "Nomad Goods", url: "https://nomadgoods.com" },

  // 7. Home & Living
  { name: "Brooklinen", url: "https://www.brooklinen.com" },
  { name: "Caraway Home", url: "https://www.carawayhome.com" },
  { name: "Our Place", url: "https://fromourplace.com" },
  { name: "Boll & Branch", url: "https://www.bollandbranch.com" },
  { name: "Great Jones Goods", url: "https://greatjonesgoods.com" },

  // 8. Coffee & Beverages
  { name: "Blue Bottle Coffee", url: "https://bluebottlecoffee.com" },
  { name: "Chamberlain Coffee", url: "https://chamberlaincoffee.com" },
  { name: "Death Wish Coffee", url: "https://www.deathwishcoffee.com" },
  { name: "Liquid Death", url: "https://liquiddeath.com" },
  { name: "Olaplex", url: "https://olaplex.com" },

  // 9. Outdoor & Gear
  { name: "YETI Cooler", url: "https://www.yeti.com" },
  { name: "BioLite Energy", url: "https://www.bioliteenergy.com" },
  { name: "Cotopaxi", url: "https://www.cotopaxi.com" },
  { name: "The Ridge Wallet", url: "https://ridge.com" },
  { name: "Rumpl Blankets", url: "https://www.rumpl.com" },

  // 10. Supplements & Wellness
  { name: "Huel", url: "https://huel.com" },
  { name: "Ritual Vitamins", url: "https://ritual.com" },
  { name: "Liquid I.V.", url: "https://www.liquid-iv.com" },
  { name: "Bulletproof", url: "https://www.bulletproof.com" },
  { name: "Onnit", url: "https://www.onnit.com" },
];

async function main() {
  const config = loadConfig();
  const store = new ProfileStore(config.browser.profileDir);

  console.log(`[+] Bulk creating 50 profiles in directory: ${config.browser.profileDir}...`);

  for (let i = 0; i < STORES.length; i++) {
    const s = STORES[i];
    const profile = await store.create({
      name: `Slot ${i + 1} - ${s.name}`,
      storefront: s.url,
      durationMinutes: 7,
      atcMinutes: 3,
      notes: `Bulk created for 50-stream test: ${s.name}`,
    });
    console.log(`[✓] Created Profile #${profile.ordinal}: ${profile.name} -> ${profile.storefront} (7m duration, 3m ATC)`);
  }

  console.log(`\n[+] Successfully created all 50 profiles! Total in store: ${store.list().length}`);
}

main().catch(console.error);
