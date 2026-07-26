/// Closure-generated `ta`/`qa`/`ha` support references now travel through the
/// `$gcc` prefix namespace, so only tslib-style helper bodies are pooled.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) enum SharedEs5HelperKind {
    ClassPrivateFieldSet,
    ClassPrivateFieldGet,
    SetFunctionName,
    RunInitializers,
    EsDecorate,
}

impl SharedEs5HelperKind {
    pub(super) fn key(self) -> &'static str {
        match self {
            Self::ClassPrivateFieldSet => "class-private-field-set",
            Self::ClassPrivateFieldGet => "class-private-field-get",
            Self::SetFunctionName => "set-function-name",
            Self::RunInitializers => "run-initializers",
            Self::EsDecorate => "es-decorate",
        }
    }

    pub(super) fn slot(self) -> usize {
        match self {
            Self::ClassPrivateFieldSet => 0,
            Self::ClassPrivateFieldGet => 1,
            Self::SetFunctionName => 2,
            Self::RunInitializers => 3,
            Self::EsDecorate => 4,
        }
    }
}
