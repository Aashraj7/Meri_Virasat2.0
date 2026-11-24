'use strict';

/* The category catalog is seeded once into an empty database and then managed
   as ordinary rows. It is the only starter content the app creates — heritage
   records are always contributed by real users. */

export const CATEGORIES = [
  ['Folk Songs', 'Traditional songs, ballads & oral music', 'fa-music'],
  ['Folk Dances', 'Community dances & performance traditions', 'fa-person-running'],
  ['Recipes & Food', 'Traditional recipes, foods & cooking knowledge', 'fa-bowl-food'],
  ['Childhood Games', 'Traditional games played across generations', 'fa-gamepad'],
  ['Temples', 'Temples, shrines & sacred architecture', 'fa-gopuram'],
  ['Churches', 'Churches & Christian heritage places', 'fa-church'],
  ['Mosques', 'Mosques & Islamic heritage architecture', 'fa-mosque'],
  ['Gurudwaras', 'Sikh religious places & traditions', 'fa-place-of-worship'],
  ['Old Places', 'Historic buildings, streets & places', 'fa-landmark'],
  ['Forts & Palaces', 'Forts, palaces & royal heritage', 'fa-chess-rook'],
  ['Folk Art', 'Paintings, murals & community art', 'fa-palette'],
  ['Crafts & Handicrafts', 'Traditional crafts & artisan skills', 'fa-hands'],
  ['Festivals & Rituals', 'Festivals, rituals & community customs', 'fa-dharmachakra'],
  ['Folk Theatre', 'Traditional theatre, puppetry & performance', 'fa-masks-theater'],
  ['Traditional Clothing', 'Traditional dress, textiles & adornment', 'fa-shirt'],
  ['Oral Stories & Legends', 'Stories, legends, myths & oral histories', 'fa-book-open'],
  ['Languages & Dialects', 'Regional languages, dialects & expressions', 'fa-language'],
  ['Music & Instruments', 'Traditional music, instruments & musicians', 'fa-drum'],
  ['Architecture', 'Traditional buildings & architectural knowledge', 'fa-building-columns'],
  ['Nature & Sacred Landscapes', 'Sacred groves, rivers & natural heritage', 'fa-tree']
];
