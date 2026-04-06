import { Button, ButtonGroup, InlineStack, Text } from '@shopify/polaris';
import { useTranslation } from 'react-i18next';
import { makeLocaleCookie } from '~/utils/locale';

const LanguageSwitcher = ({ value = 'ja', onChange }) => {
  const { t, i18n } = useTranslation('common');

  const handleChange = (selectedValue) => {
    if (onChange) {
      onChange(selectedValue);
    }
    
    // i18nの言語も直接変更
    i18n.changeLanguage(selectedValue);
    
    // localStorageにも保存
    localStorage.setItem('i18nextLng', selectedValue);
    document.cookie = makeLocaleCookie(selectedValue);
  };

  return (
    <InlineStack gap="200" align="center" blockAlign="center">
      <Text as="span" variant="bodySm" tone="subdued">
        {t('language.switch')}
      </Text>
      <ButtonGroup variant="segmented">
        <Button
          pressed={value === 'ja'}
          onClick={() => handleChange('ja')}
        >
          {t('language.japanese')}
        </Button>
        <Button
          pressed={value === 'en'}
          onClick={() => handleChange('en')}
        >
          {t('language.english')}
        </Button>
      </ButtonGroup>
    </InlineStack>
  );
};

export default LanguageSwitcher;
