//! External-boundary identity tokens and evidence mode.

use std::collections::{BTreeMap, BTreeSet, HashMap};

pub(crate) fn boundary_identity(module_id: &str, external_specifier: &str) -> String {
    format!("{module_id}\0{external_specifier}")
}

pub(crate) fn allocate_boundary_identity_tokens(
    identities: impl IntoIterator<Item = String>,
) -> HashMap<String, String> {
    allocate_boundary_identity_tokens_with(identities, crate::utils::hash48_base36)
}

pub(crate) fn allocate_boundary_identity_tokens_with(
    identities: impl IntoIterator<Item = String>,
    token_for: impl Fn(&str) -> String,
) -> HashMap<String, String> {
    let mut groups = BTreeMap::<String, Vec<String>>::new();
    for identity in identities.into_iter().collect::<BTreeSet<_>>() {
        groups
            .entry(token_for(&identity))
            .or_default()
            .push(identity);
    }
    let mut tokens = HashMap::new();
    for (base, identities) in groups {
        if identities.len() == 1 {
            tokens.insert(identities[0].clone(), base);
            continue;
        }
        for (ordinal, identity) in identities.into_iter().enumerate() {
            tokens.insert(
                identity,
                format!("{base}z{}", crate::utils::base36(ordinal as u64)),
            );
        }
    }
    tokens
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExternalBoundaryEvidence {
    All,
    GlobalOnly,
}
