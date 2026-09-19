//! Types for Oxc dynamic-import wrapper-flow analysis.

use std::collections::{BTreeMap, BTreeSet};

use crate::transpile::identity::BindingKeyMap;

#[derive(Clone, Debug, Default)]
pub(crate) struct DynamicImportWrappers {
    pub(crate) functions: BindingKeyMap<BTreeSet<String>>,
    pub(crate) objects: BindingKeyMap<DynamicImportObjectWrapper>,
    pub(crate) object_factories: BindingKeyMap<DynamicImportObjectWrapper>,
}

pub(crate) type DynamicImportObjectWrapper = BTreeMap<String, BTreeSet<String>>;
