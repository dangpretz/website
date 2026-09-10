/* eslint-disable max-len, object-curly-newline */
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ INGREDIENT CATALOG — SINGLE SOURCE OF TRUTH                              ║
// ╠══════════════════════════════════════════════════════════════════════════╣
// ║                                                                          ║
// ║ The purchasing-ingredient list, shared by every ops page that shows or   ║
// ║ selects an ingredient: Inventory, Recipes, Receiving, Receiving History, ║
// ║ Inventory Forecast. Each used to hardcode its own copy and they drifted  ║
// ║ (names, pack sizes, which items even existed). This is now the only copy.║
// ║                                                                          ║
// ║ FIELDS                                                                   ║
// ║   id           stable key — referenced by productId in the /dangpretz/   ║
// ║                recipes and /dangpretz/inventory logs, so NEVER change or  ║
// ║                reuse one. `usf-<code>` for US Foods items, `new-<code>`   ║
// ║                for ones added via receiving, ad-hoc slugs otherwise.     ║
// ║   name         short operator-facing name (what Inventory / Recipes show)║
// ║   orderName     full US Foods catalog name, when it differs — Receiving  ║
// ║                and Receiving History show `orderName || name`.           ║
// ║   packSize     "<casesPerX>/<innerQty>/<UNIT>" (US Foods pack notation); ║
// ║                '' when the item has no standard pack format.             ║
// ║   usFoodsCode  US Foods item number — the value a scanned barcode maps   ║
// ║                to; absent for non-US-Foods items.                        ║
// ║   requiresTemp true = cold-chain, Receiving prompts for a temp reading.  ║
// ║   par          default PAR level for the Inventory low-stock check.      ║
// ║                                                                          ║
// ║ resolveIngredients(receivingLogs) applies the live receiving log on top: ║
// ║ drops `archive_product` ids, appends `new_product` entries, sorts by     ║
// ║ name. Pure — pass fresh logs, get a fresh array.                         ║
// ║                                                                          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export const INGREDIENT_CATALOG = [
  { id: 'usf-4922290', name: 'Bakery Spray', packSize: '6/14/OZ', usFoodsCode: '4922290', requiresTemp: false, par: 3 },
  { id: 'usf-7911365', name: 'Bathroom Cleaner', packSize: '6/24/OZ', usFoodsCode: '7911365', requiresTemp: false, par: 1 },
  { id: 'dabs-beer-nyf', name: 'Beer, Bottle, Not Your Fathers', packSize: '1/1/BTL', requiresTemp: false, par: 0 },
  { id: 'dabs-beer-2row', name: 'Beer, Can, 2 Row Farmhouse', packSize: '1/1/CN', requiresTemp: false, par: 0 },
  { id: 'gen-beer-ath-fw', name: 'Beer, Can, Athletic Free Wave', packSize: '24/1/CN', requiresTemp: false, par: 0 },
  { id: 'gen-beer-ath-ud', name: 'Beer, Can, Athletic Upside Dawn', packSize: '24/1/CN', requiresTemp: false, par: 0 },
  { id: 'fisher-cerveza', name: 'Beer, Can, Fisher Cerveza', packSize: '24/1/CN', requiresTemp: false, par: 6 },
  { id: 'fisher-pilsner', name: 'Beer, Can, Fisher Pilsner', packSize: '24/1/CN', requiresTemp: false, par: 0 },
  { id: 'dabs-beer-housewine', name: 'Beer, Can, House Wine', packSize: '1/1/CN', requiresTemp: false, par: 6 },
  { id: 'dabs-beer-melvin', name: 'Beer, Can, Melvin IPA', packSize: '1/1/CN', requiresTemp: false, par: 0 },
  { id: 'dabs-beer-roadhouse', name: 'Beer, Can, Roadhouse Plasma Hazy', packSize: '1/1/CN', requiresTemp: false, par: 0 },
  { id: 'ss-beer-cider', name: 'Beer, Can, Second Summit Cider', packSize: '24/1/CN', requiresTemp: false, par: 0 },
  { id: 'tf-beer-ling', name: 'Beer, Can, TF Lingonberry Sour', packSize: '24/1/CN', requiresTemp: false, par: 0 },
  { id: 'tf-beer-wsp', name: 'Beer, Can, TF Wicked Sea Party', packSize: '24/1/CN', requiresTemp: false, par: 0 },
  { id: 'gen-keg-bohemian', name: 'Beer, Keg, Bohemian Sir-Veza', packSize: '1/6/BBL', requiresTemp: false, par: 0 },
  { id: 'hkbc-keg-ginger', name: 'Beer, Keg, HK Ginger Hibiscus', packSize: '1/6/Keg', requiresTemp: false, par: 0 },
  { id: 'car-keg-kiitos', name: 'Beer, Keg, Kiitos Amber', packSize: '1/6/BBL', requiresTemp: false, par: 0 },
  { id: 'offset-keg-dopo', name: 'Beer, Keg, Offset Dopo', packSize: '1/6/BBL', requiresTemp: false, par: 0 },
  { id: 'ss-keg-peach', name: 'Beer, Keg, Second Summit Spiced Peach', packSize: '1/6/BBL', requiresTemp: false, par: 0 },
  { id: 'car-keg-helles', name: 'Beer, Keg, TF Helles', packSize: '1/6/BBL', requiresTemp: false, par: 0 },
  { id: 'gen-keg-angeles', name: 'Beer, Keg, Uinta Was Angeles', packSize: '1/6/BBL', requiresTemp: false, par: 0 },
  { id: 'car-keg-peach2', name: 'Beer, Keg, UTOG Son of a Peach', packSize: '1/6/BBL', requiresTemp: false, par: 1 },
  { id: 'usf-1345057', name: 'Blueberry, Frozen 30 lb', packSize: '1/30/LB', usFoodsCode: '1345057', requiresTemp: false, par: 0 },
  { id: 'usf-0877506', name: 'Butter', orderName: 'Butter, Salted Solid AA Grd', packSize: '36/1/LB', usFoodsCode: '0877506', requiresTemp: true, par: 80 },
  { id: 'usf-1332642', name: 'Cheese, Cheddar', orderName: 'Cheese, Cheddar Mild Shredded', packSize: '4/5/LB', usFoodsCode: '1332642', requiresTemp: true, par: 3 },
  { id: 'usf-6401780', name: 'Cheese, Cheddar Sharp', orderName: 'Cheese, Cheddar Sharp Shredded', packSize: '4/5/LB', usFoodsCode: '6401780', requiresTemp: true },
  { id: 'usf-8123322', name: 'Cheese, Cheddar Yellow Mild', orderName: 'Cheese, Cheddar Yellow Mild Shredded', packSize: '4/5/LB', usFoodsCode: '8123322', requiresTemp: true },
  { id: 'usf-0746479', name: 'Cheese, Cheddar/Monterey Mix', orderName: 'Cheese, Pepper Jack Shredded Bag', packSize: '4/5/LB', usFoodsCode: '0746479', requiresTemp: true, par: 20 },
  { id: 'usf-8340861', name: 'Cheese, Cream Loaf', orderName: 'Cheese, Cream Plain Loaf', packSize: '10/3/LB', usFoodsCode: '8340861', requiresTemp: true, par: 8 },
  { id: 'sysco-7005922', name: 'Cheese, Firehouse Blend', packSize: '2/5/LB', requiresTemp: false, par: 5 },
  { id: 'usf-1492816', name: 'Cheese, Parmesan, Shaved', orderName: 'Cheese, Parmesan Shaved Bag', packSize: '2/5/LB', usFoodsCode: '1492816', requiresTemp: true, par: 10 },
  { id: 'usf-1324079', name: 'Cream, Heavy', orderName: 'Cream, Whipping Heavy 40%', packSize: '2/1/GAL', usFoodsCode: '1324079', requiresTemp: true, par: 3 },
  { id: 'utahpaper-box-large', name: 'Dangerous Pretzel Box, Large', packSize: '', requiresTemp: false, par: 0 },
  { id: 'utahpaper-box-small', name: 'Dangerous Pretzel Box, Small', packSize: '', requiresTemp: false, par: 0 },
  { id: 'usf-8091092', name: 'Flour', packSize: '1/50/LB', usFoodsCode: '8091092', requiresTemp: false, par: 20 },
  { id: 'usf-1008416', name: 'Flour, Bread Enriched Bleached Big Loaf', packSize: '1/50/LB', usFoodsCode: '1008416', requiresTemp: false },
  { id: 'usf-5175377', name: 'Franks Hot Sauce', packSize: '4/1/GAL', usFoodsCode: '5175377', requiresTemp: false, par: 2 },
  { id: 'amz-fruity-pebbles', name: 'Fruity Pebbles', packSize: '1/32/OZ', requiresTemp: false, par: 1 },
  { id: 'usf-3330487', name: 'Garlic, Chopped', orderName: 'Garlic, Chopped in Water', packSize: '6/32/OZ', usFoodsCode: '3330487', requiresTemp: true, par: 4 },
  { id: 'usf-7807993', name: 'Glove, Vinyl Medium', packSize: '10/100/EA', usFoodsCode: '7807993', requiresTemp: false },
  { id: 'usf-7808017', name: 'Gloves, Extra Large', packSize: '10/100/CT', usFoodsCode: '7808017', requiresTemp: false, par: 500 },
  { id: 'usf-7808009', name: 'Gloves, Large', packSize: '10/100/CT', usFoodsCode: '7808009', requiresTemp: false, par: 500 },
  { id: 'usf-7807985', name: 'Gloves, Medium', packSize: '10/100/CT', usFoodsCode: '7807985', requiresTemp: false, par: 500 },
  { id: 'sysco-hair-nets', name: 'Hair Nets', packSize: '10/144/CT', requiresTemp: false, par: 100 },
  { id: 'sysco-hand-soap', name: 'Hand Soap', packSize: '4/1/GAL', requiresTemp: false, par: 2 },
  { id: 'usf-7017429', name: 'Herb, Basil, Fresh', orderName: 'Basil, Fresh Herb', packSize: '1/1/LB', usFoodsCode: '7017429', requiresTemp: true, par: 0 },
  { id: 'usf-7326432', name: 'Herb, Parsley, Fresh', orderName: 'Parsley, Washed and Destemmed', packSize: '4/1/LB', usFoodsCode: '7326432', requiresTemp: true, par: 2 },
  { id: 'usf-3737152', name: 'Honey', orderName: 'Honey, Amber Light', packSize: '1/5/LB', usFoodsCode: '3737152', requiresTemp: false, par: 1 },
  { id: 'usf-1692498', name: 'Honey, Hot', packSize: '1/1/GAL', usFoodsCode: '1692498', requiresTemp: false, par: 2 },
  { id: 'usf-6773394', name: 'Lemon Juice', orderName: 'Juice, Lemon Meyer Blend', packSize: '1/0.5/GAL', usFoodsCode: '6773394', requiresTemp: false, par: 0 },
  { id: 'sham-margarine', name: 'Margarine, Vegan', packSize: '', requiresTemp: false, par: 30 },
  { id: 'usf-7329113', name: 'Mayonnaise', orderName: 'Mayonnaise, Heavy Plastic Jug Shelf Stable', packSize: '4/1/GAL', usFoodsCode: '7329113', requiresTemp: false, par: 4 },
  { id: 'usf-4364063', name: 'Mustard', orderName: 'Mustard, Yellow Plastic Jar Shelf Stable', packSize: '4/1/GAL', usFoodsCode: '4364063', requiresTemp: false, par: 4 },
  { id: 'usf-7330202', name: 'Mustard, Whole Grain', orderName: 'Mustard, Dijon Whole Grain Can', packSize: '1/8.6/LB', usFoodsCode: '7330202', requiresTemp: false, par: 1 },
  { id: 'usf-7634157', name: 'Napkin, Dinner', packSize: '30/160/CT', usFoodsCode: '7634157', requiresTemp: false, par: 8 },
  { id: 'amz-packing-tape', name: 'Packing Tape', packSize: '', requiresTemp: false, par: 4 },
  { id: 'usf-9929174', name: 'Pepper, Fresno', orderName: 'Pepper, Jalapeno #1 Fresh', packSize: '1/5/LB', usFoodsCode: '9929174', requiresTemp: true, par: 3 },
  { id: 'usf-3547205', name: 'Pepper, Jalapeno', orderName: 'Pepper, Chili, Fresno Red Fresh', packSize: '1/10/LB', usFoodsCode: '3547205', requiresTemp: true, par: 2 },
  { id: 'sysco-7110280', name: 'Pepperoni, Diced', packSize: '2/5/LB', requiresTemp: false, par: 2 },
  { id: 'sysco-7293935', name: 'Pepperoni, Sliced', packSize: '2/12.5/LB', requiresTemp: false, par: 1 },
  { id: 'sysco-portion-cup-2oz', name: 'Portion Cup, 2 oz', packSize: '12/200/CT', requiresTemp: false, par: 0 },
  { id: 'sysco-portion-cup-2oz-l', name: 'Portion Cup, 2 oz Lids', packSize: '24/100/CT', requiresTemp: false, par: 0 },
  { id: 'usf-1851438', name: 'Portion Cup, 3 oz', packSize: '15/200/CT', usFoodsCode: '1851438', requiresTemp: false, par: 1500 },
  { id: 'usf-2939411', name: 'Portion Cup, 3 oz Lids', packSize: '20/120/CT', usFoodsCode: '2939411', requiresTemp: false, par: 1500 },
  { id: 'usf-5328406', name: 'Ranch Dressing', orderName: 'Dressing, Ranch, Buttermilk', packSize: '4/1/GAL', usFoodsCode: '5328406', requiresTemp: true, par: 3 },
  { id: 'amz-receipt-paper', name: 'Receipt Paper', packSize: '1/10/CT', requiresTemp: false, par: 4 },
  { id: 'usf-2373579', name: 'Salt, Pretzel', packSize: '1/25/LB', usFoodsCode: '2373579', requiresTemp: false, par: 1 },
  { id: 'usf-0033858', name: 'Salt, Sea', orderName: 'Salt, Sea KO Not Iodz Gran Box', packSize: '12/3/LB', usFoodsCode: '0033858', requiresTemp: false, par: 12 },
  { id: 'gen-soda-brighams', name: 'Soda Bottles, Brighams Brew', packSize: '', requiresTemp: false, par: 24 },
  { id: 'amz-soda-btl-coke', name: 'Soda Bottles, Coke', packSize: '1/24/EA', requiresTemp: false, par: 8 },
  { id: 'amz-soda-btl-czero', name: 'Soda Bottles, Coke Zero', packSize: '1/24/EA', requiresTemp: false, par: 8 },
  { id: 'amz-soda-btl-dcoke', name: 'Soda Bottles, Diet Coke', packSize: '1/24/EA', requiresTemp: false, par: 8 },
  { id: 'amz-soda-btl-sprite', name: 'Soda Bottles, Sprite', packSize: '1/24/EA', requiresTemp: false, par: 8 },
  { id: 'amz-soda-btl-water', name: 'Soda Bottles, Water', packSize: '1/24/EA', requiresTemp: false, par: 12 },
  { id: 'amz-soda-can-coke', name: 'Soda Cans, Coke', packSize: '1/12/EA', requiresTemp: false, par: 6 },
  { id: 'amz-soda-can-czero', name: 'Soda Cans, Coke Zero', packSize: '1/12/EA', requiresTemp: false, par: 6 },
  { id: 'amz-soda-can-dcoke', name: 'Soda Cans, Diet Coke', packSize: '1/12/EA', requiresTemp: false, par: 6 },
  { id: 'amz-soda-can-ddpepper', name: 'Soda Cans, Diet Dr. Pepper', packSize: '1/12/EA', requiresTemp: false, par: 6 },
  { id: 'amz-soda-can-dpepper', name: 'Soda Cans, Dr. Pepper', packSize: '1/12/EA', requiresTemp: false, par: 6 },
  { id: 'amz-soda-can-sprite', name: 'Soda Cans, Sprite', packSize: '1/12/EA', requiresTemp: false, par: 6 },
  { id: 'amz-sodium-citrate', name: 'Sodium Citrate', packSize: '1/8/LB', requiresTemp: false, par: 1 },
  { id: 'amz-soup-liner', name: 'Soup Liner Bag Rolls', packSize: '', requiresTemp: false, par: 0 },
  { id: 'usf-7635246', name: 'Sour Cream', packSize: '2/5/LB', usFoodsCode: '7635246', requiresTemp: false, par: 3 },
  { id: 'usf-760876', name: 'Spice, Cinnamon, Ground', packSize: '3/5/LB', usFoodsCode: '760876', requiresTemp: false, par: 1 },
  { id: 'usf-760884', name: 'Spice, Garlic, Powder', packSize: '1/6/LB', usFoodsCode: '760884', requiresTemp: false, par: 1 },
  { id: 'usf-760991', name: 'Spice, Italian Seasoning', packSize: '1/28/OZ', usFoodsCode: '760991', requiresTemp: false, par: 1 },
  { id: 'usf-9032400', name: 'Spice, Mustard, Powder', packSize: '', usFoodsCode: '9032400', requiresTemp: false, par: 1 },
  { id: 'usf-6494538', name: 'Spice, Onion, Powdered', packSize: '1/6/LB', usFoodsCode: '6494538', requiresTemp: false, par: 1 },
  { id: 'usf-760652', name: 'Spice, Rosemary, Dried', packSize: '1/6/OZ', usFoodsCode: '760652', requiresTemp: false, par: 6 },
  { id: 'sysco-steam-pan', name: 'Steam Table Pan', packSize: '40/1/EA', requiresTemp: false, par: 0 },
  { id: 'sysco-steam-pan-lid', name: 'Steam Table Pan Lid', packSize: '80/1/EA', requiresTemp: false, par: 0 },
  { id: 'gen-sticker-sheets', name: 'Sticker Sheets', packSize: '', requiresTemp: false, par: 40 },
  { id: 'gen-sugar-brown', name: 'Sugar, Brown', packSize: '', requiresTemp: false, par: 1 },
  { id: 'usf-4005906', name: 'Sugar, Granulated', packSize: '1/50/LB', usFoodsCode: '4005906', requiresTemp: false, par: 1 },
  { id: 'usf-7016876', name: 'Sugar, Powdered', orderName: 'Sugar, Powdered Confectionary', packSize: '1/50/LB', usFoodsCode: '7016876', requiresTemp: false, par: 1 },
  { id: 'usf-3733821', name: 'Toilet Paper', packSize: '80/500/CT', usFoodsCode: '3733821', requiresTemp: false, par: 30 },
  { id: 'usf-8609075', name: 'Towel, Multifold', packSize: '16/250/EA', usFoodsCode: '8609075', requiresTemp: false, par: 16 },
  { id: 'usf-5329420', name: 'Trash Bags', orderName: 'Liner, 60 Gal', packSize: '100/60/GAL', usFoodsCode: '5329420', requiresTemp: false, par: 100 },
  { id: 'amz-twist-ties', name: 'Twist Ties', packSize: '', requiresTemp: false, par: 1 },
  { id: 'amz-vac-bag-large', name: 'Vacuum Seal Bags, Large', packSize: '', requiresTemp: false, par: 400 },
  { id: 'amz-vac-bag-small', name: 'Vacuum Seal Bags, Small', packSize: '', requiresTemp: false, par: 1500 },
  { id: 'amz-vac-roll-wide', name: 'Vacuum Seal Rolls, Wide', packSize: '1/3/roll', requiresTemp: false, par: 5 },
  { id: 'usf-761346', name: 'Vanilla Flavoring', packSize: '1/1/GAL', usFoodsCode: '761346', requiresTemp: false, par: 1 },
  { id: 'sysco-wrap-paper', name: 'Wrap Paper 12 x 12', packSize: '1/1000/CT', requiresTemp: false, par: 1000 },
  { id: 'usf-3022647', name: 'Yeast', orderName: 'Yeast, Dry Active', packSize: '20/1/LB', usFoodsCode: '3022647', requiresTemp: false, par: 27 },
];

// The live catalog: INGREDIENT_CATALOG with the receiving log applied —
// `archive_product` rows remove an id, `new_product` rows add one. Matches the
// old per-page buildDynamicProducts() but shared and non-mutating.
//
// `includeArchived: true` keeps archived items in the list — Receiving and
// Receiving History pass it so a delivery of a de-listed item can still be
// scanned and logged. Inventory / Recipes / Forecast use the default (archived
// items drop out).
export function resolveIngredients(receivingLogs, { includeArchived = false } = {}) {
  const logs = Array.isArray(receivingLogs) ? receivingLogs : [];
  const archived = new Set(
    logs.filter((r) => r.action === 'archive_product' && r.productId).map((r) => r.productId),
  );
  const drop = (id) => !includeArchived && archived.has(id);

  const out = INGREDIENT_CATALOG.filter((p) => !drop(p.id)).map((p) => ({ ...p }));
  const haveCode = new Set(out.map((p) => p.usFoodsCode).filter(Boolean));
  const haveId = new Set(out.map((p) => p.id));

  logs.filter((r) => r.action === 'new_product').forEach((r) => {
    // Receiving writes `usFoodsCode`; Receiving History's identify-later flow
    // writes a raw `barcode` (non-US-Foods suppliers). Key on whichever exists;
    // keep the raw barcode as its own field so a full-barcode scan still matches.
    const code = r.usFoodsCode || r.barcode || '';
    if (!code || !r.productName) return;
    const id = `new-${code}`;
    if (drop(id) || haveId.has(id) || haveCode.has(code)) return;
    haveId.add(id);
    haveCode.add(code);
    out.push({
      id,
      name: r.productName,
      orderName: r.productName,
      packSize: r.packSize || '',
      usFoodsCode: code,
      requiresTemp: r.requiresTemp === true || r.requiresTemp === 'true',
      ...(r.barcode && !r.usFoodsCode ? { barcode: r.barcode } : {}),
    });
  });

  return out.sort((a, b) => a.name.localeCompare(b.name));
}
