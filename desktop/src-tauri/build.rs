fn main() {
    // Rebuild when the site URL changes, so a new DAYBOUND_URL always lands in the binary.
    println!("cargo:rerun-if-env-changed=DAYBOUND_URL");
    tauri_build::build()
}
