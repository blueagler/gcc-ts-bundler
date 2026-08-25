#[derive(Clone, Copy)]
pub(crate) struct SourceEdit {
    pub(crate) end: usize,
    pub(crate) replacement_len: usize,
    pub(crate) start: usize,
}

pub(crate) fn remap_source_offset(offset: u32, edits: &[SourceEdit]) -> Option<u32> {
    let offset = offset as usize;
    let mut delta = 0isize;
    for edit in edits {
        if offset < edit.start {
            break;
        }
        if offset < edit.end {
            return None;
        }
        delta += edit.replacement_len as isize - (edit.end - edit.start) as isize;
    }
    u32::try_from(offset.checked_add_signed(delta)?).ok()
}
