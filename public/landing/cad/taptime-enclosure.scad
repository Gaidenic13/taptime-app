// TapTime NFC checkpoint — solid case MVP, revision 2
// Units: millimetres. Export front_case() and rear_case() separately.
$fn = 64;
W = 56; H = 56; R = 9;

module rounded_box(w,h,d,r) {
  linear_extrude(d) offset(r=r) square([w-2*r,h-2*r], center=true);
}

module front_case() {
  difference() {
    rounded_box(W,H,11,R);
    // A real case cavity: 3 mm front and 3 mm perimeter walls.
    translate([0,0,3]) rounded_box(W-6,H-6,9,R-3);
    // Four sockets receive the rear-case snap pegs.
    for(x=[-21.5,21.5], y=[-21.5,21.5])
      translate([x,y,5.5]) cylinder(h=5.8,d=3.5);
    // Recessed wordmark prints as part of the case—no label required.
    translate([0,0,-0.1]) mirror([0,1,0]) linear_extrude(0.75)
      text("TAPTIME",size=3.4,halign="center",valign="center",font="Arial:style=Bold");
  }
  // Internal NFC cradle. The 25 mm sticker sits inside the case.
  translate([0,0,3]) difference() {
    cylinder(h=1.8,d=30);
    cylinder(h=2,d=25.6);
  }
}

module rear_case() {
  difference() {
    union() {
      // 6 mm structural back + 2 mm locating lip inside front case.
      rounded_box(W,H,6,R);
      translate([0,0,6]) rounded_box(W-6.5,H-6.5,2,R-3.25);
      for(x=[-21.5,21.5], y=[-21.5,21.5])
        translate([x,y,6]) cylinder(h=4.2,d1=3.15,d2=3.0);
    }
    // Optional countersunk wall screws.
    for(y=[-16,16]) {
      translate([0,y,-0.1]) cylinder(h=8.2,d=4.2);
      translate([0,y,0]) cylinder(h=2.4,d1=8.2,d2=4.2);
    }
    // Two internal 15 x 3 mm magnet pockets.
    for(x=[-16,16]) translate([x,0,0.8]) cylinder(h=3.2,d=15.4);
    // Pry notch for reopening the case.
    translate([0,-28,5]) cube([13,7,4],center=true);
  }
}

// Exploded preview. Comment one part and export the other as STL.
color("#078f98") translate([0,0,12]) front_case();
color("#f3b94d") translate([0,0,10.5]) cylinder(h=0.7,d=25);
color("#e8e7df") rear_case();
