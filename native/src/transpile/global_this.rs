use super::*;

pub(super) fn collect_global_this_compat_property_names(
    program: &Program,
    global_scope: GlobalScope,
) -> HashSet<String> {
    let mut collector = GlobalThisCompatCollector::new(global_scope);
    program.visit_with(&mut collector);
    collector.properties
}

struct GlobalThisCompatCollector {
    aliases: BindingKeySet,
    properties: HashSet<String>,
    global_scope: GlobalScope,
}

impl GlobalThisCompatCollector {
    fn new(global_scope: GlobalScope) -> Self {
        Self {
            aliases: BindingKeySet::new(),
            properties: HashSet::new(),
            global_scope,
        }
    }

    fn is_global_this_expr(&self, expr: &Expr) -> bool {
        matches!(expr, Expr::Ident(ident) if ident.sym == *"globalThis" && self.global_scope.contains(ident))
    }

    fn is_global_this_alias_expr(&self, expr: &Expr) -> bool {
        matches!(expr, Expr::Ident(ident) if self.aliases.contains(&BindingKey::of(ident)))
    }

    fn is_global_object_expr(&self, expr: &Expr) -> bool {
        self.is_global_this_expr(expr) || self.is_global_this_alias_expr(expr)
    }
}

impl Visit for GlobalThisCompatCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        if let swc_core::ecma::ast::Pat::Ident(binding) = &declarator.name {
            if let Some(init) = &declarator.init {
                if self.is_global_object_expr(init) {
                    self.aliases.insert(BindingKey::of_binding(binding));
                }
            }
        }

        declarator.visit_children_with(self);
    }

    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        if let Expr::Ident(object_ident) = &*member_expr.obj {
            if self.is_global_object_expr(&Expr::Ident(object_ident.clone())) {
                if let Some(property_name) = member_prop_name(&member_expr.prop) {
                    self.properties.insert(property_name);
                }
            }
        }

        member_expr.visit_children_with(self);
    }
}

pub(super) struct GlobalThisCompatVisitor {
    replacements: HashMap<String, Box<Expr>>,
    global_scope: GlobalScope,
}

impl GlobalThisCompatVisitor {
    pub(super) fn new(
        property_names: HashSet<String>,
        global_scope: GlobalScope,
    ) -> std::result::Result<Self, String> {
        let mut replacements = HashMap::new();
        for property_name in property_names {
            replacements.insert(
                property_name.clone(),
                parse_global_this_property_expr(&property_name)?,
            );
        }

        Ok(Self {
            replacements,
            global_scope,
        })
    }
}

impl VisitMut for GlobalThisCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        if let Expr::Ident(ident) = expr {
            if self.global_scope.contains(ident) {
                if let Some(replacement) = self.replacements.get(ident.sym.as_ref()) {
                    *expr = *replacement.clone();
                }
            }
        }
    }
}

fn parse_global_this_property_expr(property_name: &str) -> std::result::Result<Box<Expr>, String> {
    let expression = if is_valid_identifier(property_name) {
        format!("globalThis.{property_name};")
    } else {
        format!("globalThis[{:?}];", property_name)
    };
    let module = parse_module(&PathBuf::from("compat-snippet.js"), &expression)?;
    let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = module
        .body
        .into_iter()
        .next()
        .ok_or_else(|| "missing compat snippet expression".to_string())?
    else {
        return Err("invalid compat snippet expression".to_string());
    };
    let Expr::Member(MemberExpr { .. }) = &*expr else {
        return Err("invalid compat snippet member expression".to_string());
    };
    Ok(expr)
}

pub(super) fn member_prop_name(prop: &MemberProp) -> Option<String> {
    match prop {
        MemberProp::Ident(ident) => Some(ident.sym.to_string()),
        MemberProp::Computed(computed) => match &*computed.expr {
            Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) => {
                Some(value.value.to_string_lossy().to_string())
            }
            _ => None,
        },
        _ => None,
    }
}

fn is_valid_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    match characters.next() {
        Some(character)
            if character.is_ascii_alphabetic() || character == '_' || character == '$' => {}
        _ => return false,
    }

    characters
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}
