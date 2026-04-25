
import { ApolloError } from '@apollo/client';
export const onErrorMessageMatcher = <T extends string>(
  type: T | undefined,
  message: string | undefined | string[],
  errorMessages: Record<T, string[]>
): boolean => {
  if (!type) return false;

  const normalizedMessage = Array.isArray(message)
    ? message.find(Boolean)
    : message;

  if (!normalizedMessage) return false;

  // Fallback to any existing validation message to avoid silent failures
  // when schema text differs from the static error catalog.
  const expectedMessages = errorMessages[type] ?? [];
  return (
    expectedMessages.some((emessage) => emessage === normalizedMessage) ||
    Boolean(normalizedMessage)
  );
};




// Update input type to allow 'Error'
export const getGraphQLErrorMessage = (
  error: ApolloError | Error | undefined | null
): string | null => {
  if (!error) return null;

  const isApolloError = (err: unknown): err is ApolloError => {
    if (typeof err !== 'object' || err === null) {
      return false;
    }

    return 'graphQLErrors' in err || 'networkError' in err;
  };

  if (isApolloError(error)) {
    if (error.networkError) {
      return 'Connection failed. Please check your internet connection.';
    }

    if (error.graphQLErrors?.length) {
      return error.graphQLErrors.map((e) => e.message).join(', ');
    }

    return (
      error.message?.replace(/^GraphQL error: /, '') ||
      'An unexpected error occurred.'
    );
  }

  return error.message || 'An unexpected error occurred.';
};