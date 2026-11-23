import TranslationsReviewClient from "./TranslationsReviewClient";
import glossary from "../../../../../i18n/glossary.json";
import manifest from "../../../../../i18n/financial-strings.json";
import reviewState from "../../../../../i18n/review-state.json";
import en from "../../../../../messages/en.json";
import es from "../../../../../messages/es.json";
import tl from "../../../../../messages/tl.json";
import type {
  FinancialStringManifest,
  Glossary,
  Messages,
  ReviewState,
} from "../../../../../lib/i18n/financialTranslations";

export default function TranslationReviewPage() {
  return (
    <TranslationsReviewClient
      manifest={manifest as FinancialStringManifest}
      glossary={glossary as Glossary}
      initialReviewState={reviewState as ReviewState}
      sourceMessages={en as Messages}
      localizedMessages={{ en: en as Messages, es: es as Messages, tl: tl as Messages }}
    />
  );
}
